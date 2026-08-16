/* global chrome */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, "dist");
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const mailpitUrl = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const backendUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
function localBackendValue(name) {
  try {
    const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8" });
    return output.match(new RegExp(`^${name}="?(.*?)"?$`, "m"))?.[1] ?? null;
  } catch {
    return null;
  }
}
const backendAnonKey = process.env.SUPABASE_ANON_KEY ?? localBackendValue("ANON_KEY") ?? "development-only-key";
let browser;
let profilePath;

function check(condition, message) {
  if (!condition) throw new Error(`Smoke check failed: ${message}`);
  console.log(`PASS  ${message}`);
}

async function extensionIdFromTarget() {
  const deadline = Date.now() + 15_000;
  let target;
  while (!target && Date.now() < deadline) {
    target = browser.targets().find((candidate) => candidate.type() === "service_worker");
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!target) throw new Error("Packaged extension service worker target was not created.");
  const match = target.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (!match) throw new Error(`Unexpected service worker URL: ${target.url()}`);
  return match[1];
}

async function openPopup(extensionId) {
  const page = await browser.newPage();
  await page.setViewport({ width: 380, height: 600, deviceScaleFactor: 1 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForFunction(
    () => document.body.innerText.includes("You’re signed out")
      || document.body.innerText.includes("Finish setting up your account")
      || document.body.innerText.includes("Welcome,"),
    { timeout: 15_000 },
  );
  return page;
}

async function waitForOtp(email) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitUrl}/api/v1/messages`);
    const mailbox = await response.json();
    const message = mailbox.messages
      .filter((candidate) => candidate.To?.some((recipient) => recipient.Address === email))
      .sort((left, right) => String(right.Created).localeCompare(String(left.Created)))[0];
    if (message) {
      const detailResponse = await fetch(`${mailpitUrl}/api/v1/message/${message.ID}`);
      const detail = await detailResponse.json();
      const code = detail.Text?.match(/\b\d{6}\b/)?.[0];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The local OTP mailbox did not contain a six-digit code.");
}

async function sendExtensionRequest(page, request) {
  return page.evaluate(async (message) => chrome.runtime.sendMessage(message), request);
}

async function clearOtpCooldown(page) {
  await page.evaluate(async () => {
    const values = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(values).filter((key) => key.includes("otp.cooldownUntil")));
  });
}

async function clickButton(page, label) {
  await page.evaluate((buttonLabel) => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(buttonLabel));
    if (!button) throw new Error(`Button not found: ${buttonLabel}`);
    button.click();
  }, label);
}

async function workerBootCount(page) {
  return page.evaluate(() => {
    const values = [...document.querySelectorAll(".snapshot-details dd")].map((element) => element.textContent);
    return Number(values[1]);
  });
}

async function storedSessionIdentity(page) {
  return page.evaluate(async () => {
    const values = await chrome.storage.local.get(null);
    const key = Object.keys(values).find((candidate) => candidate.includes("supabase") && candidate.includes("auth-token"));
    if (!key || typeof values[key] !== "string") return null;
    const stored = JSON.parse(values[key]);
    return typeof stored.user?.id === "string" ? stored.user.id : null;
  });
}

async function storedAccessToken(page) {
  return page.evaluate(async () => {
    const values = await chrome.storage.local.get(null);
    const key = Object.keys(values).find((candidate) => candidate.includes("supabase") && candidate.includes("auth-token"));
    if (!key || typeof values[key] !== "string") return null;
    const stored = JSON.parse(values[key]);
    return typeof stored.access_token === "string" ? stored.access_token : null;
  });
}

async function readOwnAccountRpc(page) {
  const accessToken = await storedAccessToken(page);
  if (!accessToken) throw new Error("The acceptance session did not contain an access token.");
  return page.evaluate(async ({ apiUrl, anonKey, token }) => {
    const response = await fetch(`${apiUrl}/rest/v1/rpc/get_member_account_v1`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: response.status, body: await response.json() };
  }, { apiUrl: backendUrl, anonKey: backendAnonKey, token: accessToken });
}

async function readMemberTableDirectly(page) {
  const accessToken = await storedAccessToken(page);
  if (!accessToken) throw new Error("The acceptance session did not contain an access token.");
  return page.evaluate(async ({ apiUrl, anonKey, token }) => {
    const response = await fetch(`${apiUrl}/rest/v1/member_accounts?select=id,email,display_name`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    return { status: response.status, text };
  }, { apiUrl: backendUrl, anonKey: backendAnonKey, token: accessToken });
}

async function terminateWorker(page, extensionId) {
  const session = await page.createCDPSession();
  const { targetInfos } = await session.send("Target.getTargets");
  const target = targetInfos.find(
    (candidate) => candidate.type === "service_worker"
      && candidate.url === `chrome-extension://${extensionId}/service-worker.js`,
  );
  if (!target) throw new Error("Actual extension service worker target was not found.");
  await session.send("Target.closeTarget", { targetId: target.targetId });
  await session.detach();
}

try {
  const manifest = JSON.parse(await readFile(join(extensionPath, "manifest.json"), "utf8"));
  check(manifest.manifest_version === 3, "Manifest V3 package is loaded");
  profilePath = await mkdtemp(join(tmpdir(), "larp-code-smoke-"));
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: profilePath,
    enableExtensions: [extensionPath],
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  const extensionId = await extensionIdFromTarget();
  let page = await openPopup(extensionId);
  check((await page.title()) === "larp-code", "Packaged popup opens at 380 by 600");
  const firstBoot = await workerBootCount(page);
  check(Number.isInteger(firstBoot) && firstBoot >= 1, "Popup receives a fresh worker snapshot");

  const email = `smoke-${Date.now()}@example.test`;
  await clickButton(page, "Sign in with email");
  await page.type("#member-email", email);
  await clickButton(page, "Request sign-in code");
  await page.waitForFunction(() => document.body.innerText.includes("A six-digit code can be entered now"));
  let code = await waitForOtp(email);
  await page.type("#member-code", "000000");
  await clickButton(page, "Verify code");
  await page.waitForFunction(() => document.body.innerText.includes("That code is not valid")
    || document.body.innerText.includes("That code has expired")
    || document.body.innerText.includes("Too many requests"));
  const cooldown = await sendExtensionRequest(page, {
    version: 1,
    type: "resend_email_otp",
    email,
  });
  check(cooldown.ok && cooldown.auth?.status === "resend_cooldown", "OTP resend cooldown is enforced by the worker");
  await clearOtpCooldown(page);
  let rateLimited = false;
  for (let attempt = 0; attempt < 3 && !rateLimited; attempt += 1) {
    const response = await sendExtensionRequest(page, {
      version: 1,
      type: "request_email_otp",
      email,
    });
    rateLimited = response.ok && response.auth?.status === "rate_limited";
    await clearOtpCooldown(page);
  }
  check(rateLimited, "Packaged OTP flow exposes a generic rate-limited state");
  code = await waitForOtp(email);
  await page.focus("#member-code");
  await page.evaluate(() => {
    const input = document.querySelector("#member-code");
    if (!(input instanceof HTMLInputElement)) throw new Error("Code input not found");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.type("#member-code", code);
  await clickButton(page, "Verify code");
  await page.waitForFunction(() => document.body.innerText.includes("Finish setting up your account"), { timeout: 15_000 });
  check(true, "First-time email OTP sign-in receives Setup Required");
  check(await page.$eval('a[href="privacy.html"]', (link) => link.target === "_blank"), "Setup links to the public privacy policy without authentication");
  await page.type("#member-display-name", "<img src=x onerror=alert(1)>");
  await page.evaluate(() => {
    const checkbox = document.querySelectorAll('input[type="checkbox"]');
    if (checkbox.length !== 2 || !(checkbox[0] instanceof HTMLInputElement) || !(checkbox[1] instanceof HTMLInputElement)) {
      throw new Error("Consent controls not found");
    }
    checkbox.forEach((candidate) => { candidate.click(); });
  });
  const initialRace = await Promise.all([
    sendExtensionRequest(page, {
      version: 1,
      type: "create_member_account",
      displayName: "<img src=x onerror=alert(1)>",
      adultConfirmed: true,
      consentAccepted: true,
    }),
    sendExtensionRequest(page, {
      version: 1,
      type: "create_member_account",
      displayName: "<img src=x onerror=alert(1)>",
      adultConfirmed: true,
      consentAccepted: true,
    }),
  ]);
  check(initialRace.every((response) => response.ok && response.snapshot?.kind === "account"), "Initial concurrent setup submissions complete successfully");
  check(initialRace.every((response) => response.ok && response.snapshot?.account?.displayName === "<img src=x onerror=alert(1)>"), "Initial concurrent setup submissions create one durable profile");
  await clickButton(page, "Create Member Account");
  await page.waitForFunction(() => document.body.innerText.includes("Welcome, <img src=x onerror=alert(1)>") || document.body.innerText.includes("Welcome,"), { timeout: 15_000 });
  check(await page.$(".account-details img") === null, "Unsafe display name is rendered strictly as text");
  check((await page.$eval(".account-details dd", (element) => element.textContent))?.includes("<img") === true, "Display name remains visible as text");
  const duplicateSetups = await Promise.all([
    sendExtensionRequest(page, {
      version: 1,
      type: "create_member_account",
      displayName: "A different name",
      adultConfirmed: true,
      consentAccepted: true,
    }),
    sendExtensionRequest(page, {
      version: 1,
      type: "create_member_account",
      displayName: "Another different name",
      adultConfirmed: true,
      consentAccepted: true,
    }),
  ]);
  check(duplicateSetups.every((response) => response.ok && response.snapshot?.kind === "account"), "Duplicate setup submissions return an existing account snapshot");
  check(duplicateSetups.every((response) => response.ok && response.snapshot?.account?.displayName === "<img src=x onerror=alert(1)>"), "Duplicate setup submissions do not overwrite consent or profile state");
  check(true, "Packaged email OTP sign-in restores an authenticated Member Account snapshot");
  const expired = await sendExtensionRequest(page, {
    version: 1,
    type: "verify_email_otp",
    email,
    token: code,
  });
  check(expired.ok && expired.auth?.status === "expired_code", "Reusing an OTP reaches the expired-code state");
  const authenticatedIdentity = await storedSessionIdentity(page);
  check(typeof authenticatedIdentity === "string", "Acceptance captures the authenticated identity without logging it");
  await page.close();
  page = await openPopup(extensionId);
  check((await page.evaluate(() => document.body.innerText.includes("Welcome,"))), "Authenticated Member Account survives popup close and reopen");
  await terminateWorker(page, extensionId);
  await page.close();
  page = await openPopup(extensionId);
  const restartedBoot = await workerBootCount(page);
  check(restartedBoot > firstBoot, "Actual service worker termination is recoverable");
  const restored = await sendExtensionRequest(page, { version: 1, type: "get_snapshot" });
  check(restored.ok && restored.snapshot?.worker.sessionRestoredFromStorage === true, "Worker restart restores the same authenticated session from storage");
  const restartedIdentity = await storedSessionIdentity(page);
  check(restartedIdentity === authenticatedIdentity, "Worker restart restores the same authenticated identity");
  await clickButton(page, "Sign out");
  await page.waitForFunction(() => document.body.innerText.includes("You’re signed out"));
  check(true, "Sign-out clears the session and returns a signed-out result");

  const consentEmail = `smoke-consent-${Date.now()}@example.test`;
  const consentRequest = await sendExtensionRequest(page, {
    version: 1,
    type: "request_email_otp",
    email: consentEmail,
  });
  check(consentRequest.ok && consentRequest.auth?.status === "code_sent", "A fresh sign-in request remains generic after sign-out");
  const consentCode = await waitForOtp(consentEmail);
  const consentAuth = await sendExtensionRequest(page, {
    version: 1,
    type: "verify_email_otp",
    email: consentEmail,
    token: consentCode,
  });
  check(consentAuth.ok && consentAuth.snapshot?.kind === "setup_required", "Consent-rejection profile starts in Setup Required");
  const rejectedSetup = await sendExtensionRequest(page, {
    version: 1,
    type: "create_member_account",
    displayName: "Never Created",
    adultConfirmed: false,
    consentAccepted: false,
  });
  check(!rejectedSetup.ok && rejectedSetup.error?.code === "bad_request", "Backend rejects setup without affirmative consent");
  const afterRejectedSetup = await sendExtensionRequest(page, { version: 1, type: "get_snapshot" });
  check(afterRejectedSetup.ok && afterRejectedSetup.snapshot?.kind === "setup_required", "Rejected consent leaves no partial Member Account");
  const consentSignout = await sendExtensionRequest(page, { version: 1, type: "sign_out" });
  check(consentSignout.ok && consentSignout.snapshot?.kind === "signed_out", "Consent-rejection profile can be signed out without creating an account");
  await page.close();
  page = await openPopup(extensionId);

  const returningRequest = await sendExtensionRequest(page, {
    version: 1,
    type: "request_email_otp",
    email,
  });
  check(returningRequest.ok && returningRequest.auth?.status === "code_sent", "Returning same-email sign-in remains generic");
  const returningCode = await waitForOtp(email);
  const returning = await sendExtensionRequest(page, {
    version: 1,
    type: "verify_email_otp",
    email,
    token: returningCode,
  });
  check(returning.ok && returning.snapshot?.kind === "account", "Returning same email bypasses setup after re-authentication");
  await page.close();
  page = await openPopup(extensionId);
  check((await page.evaluate(() => document.body.innerText.includes("Welcome,"))), "Returning same-email account survives popup reopen");
  await clickButton(page, "Sign out");
  await page.waitForFunction(() => document.body.innerText.includes("You’re signed out"));

  const reauthEmail = `smoke-reauth-${Date.now()}@example.test`;
  const reauthRequest = await sendExtensionRequest(page, {
    version: 1,
    type: "request_email_otp",
    email: reauthEmail,
  });
  check(reauthRequest.ok && reauthRequest.auth?.status === "code_sent", "A new profile request remains generic after sign-out");
  const reauthCode = await waitForOtp(reauthEmail);
  const reauth = await sendExtensionRequest(page, {
    version: 1,
    type: "verify_email_otp",
    email: reauthEmail,
    token: reauthCode,
  });
  check(reauth.ok && reauth.snapshot?.kind === "setup_required", "A second profile starts in Setup Required");
  await page.close();
  page = await openPopup(extensionId);
  await page.type("#member-display-name", "Second Member");
  await page.evaluate(() => {
    const checkbox = document.querySelectorAll('input[type="checkbox"]');
    checkbox.forEach((candidate) => { if (candidate instanceof HTMLInputElement) candidate.click(); });
  });
  await clickButton(page, "Create Member Account");
  await page.waitForFunction(() => document.body.innerText.includes("Welcome, Second Member"), { timeout: 15_000 });
  check(true, "Second authenticated profile creates its own Member Account");
  const secondIdentity = await storedSessionIdentity(page);
  check(typeof secondIdentity === "string" && secondIdentity !== authenticatedIdentity, "Two profiles have distinct authenticated identities");
  const secondOwnAccount = await readOwnAccountRpc(page);
  check(secondOwnAccount.status === 200
    && secondOwnAccount.body?.id === secondIdentity
    && secondOwnAccount.body?.displayName === "Second Member"
    && secondOwnAccount.body?.displayName !== "<img src=x onerror=alert(1)>", "Authorized account RPC returns only the current profile");
  const directMemberRead = await readMemberTableDirectly(page);
  check([401, 403].includes(directMemberRead.status) || (directMemberRead.status === 200 && directMemberRead.text === "[]"), "Direct member table reads are blocked by the authorization boundary");
  const crossProfileSetup = await sendExtensionRequest(page, {
    version: 1,
    type: "create_member_account",
    displayName: "<img src=x onerror=alert(1)>",
    adultConfirmed: true,
    consentAccepted: true,
  });
  check(crossProfileSetup.ok
    && crossProfileSetup.snapshot?.kind === "account"
    && crossProfileSetup.snapshot.account.id === secondIdentity
    && crossProfileSetup.snapshot.account.displayName === "Second Member", "Setup replay cannot read or overwrite another profile");
  const sessionPrepared = await page.evaluate(async () => {
    const values = await chrome.storage.local.get(null);
    const key = Object.keys(values).find((candidate) => candidate.includes("supabase") && candidate.includes("auth-token"));
    if (!key || typeof values[key] !== "string") return false;
    const stored = JSON.parse(values[key]);
    stored.expires_at = Math.floor(Date.now() / 1_000) - 1;
    stored.refresh_token = "invalid-refresh-token";
    await chrome.storage.local.set({ [key]: JSON.stringify(stored) });
    return true;
  });
  check(sessionPrepared, "Acceptance fixture can expire the persisted session without exposing it");
  await terminateWorker(page, extensionId);
  await page.close();
  page = await openPopup(extensionId);
  check((await page.evaluate(() => document.body.innerText.includes("You’re signed out"))), "Authoritative refresh rejection returns to sign-in");
  execFileSync("docker", ["kill", "supabase_kong_larp-code"], { stdio: "ignore" });
  try {
    const unavailable = await sendExtensionRequest(page, { version: 1, type: "get_snapshot" });
    check(!unavailable.ok && unavailable.error?.code === "connection_unavailable", "Backend outage is shown as connection unavailable");
  } finally {
    execFileSync("docker", ["start", "supabase_kong_larp-code"], { stdio: "ignore" });
  }
  await page.close();
  console.log("Smoke OK: popup close/open and service-worker terminate/restart passed.");
} finally {
  if (browser) await browser.close();
  if (profilePath) await rm(profilePath, { recursive: true, force: true });
}
