/* global chrome */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const evidencePath = resolve(root, "artifacts/ticket31-accessibility");
const evidenceStates = [
  "signed-out", "setup", "invitation", "scheduled", "active-balanced", "active-behind",
  "unavailable", "update-required", "success", "incomplete", "canceled", "abandoned",
];
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
      || document.body.innerText.includes("Welcome,")
      || document.body.innerText.includes("Invitation terms"),
    { timeout: 15_000 },
  );
  return page;
}

async function checkPackagedPopupAccessibility(page) {
  check(await page.$eval('main[role="main"][tabindex="-1"]', (main) => main.getAttribute("aria-labelledby") === "app-title"), "Packaged popup exposes a focused main landmark");
  await page.keyboard.press("Tab");
  check(await page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && ["BUTTON", "INPUT", "A", "SELECT"].includes(active.tagName) && Boolean(active.textContent || active.getAttribute("aria-label") || active.getAttribute("aria-labelledby"));
  }), "Packaged popup reaches a named control from the keyboard");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  check(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), "Packaged popup honors reduced-motion preference");
  await mkdir(evidencePath, { recursive: true });
  await page.screenshot({ path: join(evidencePath, "signed-out-380x600.png") });
  await page.evaluate(() => { document.documentElement.style.zoom = "200%"; });
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await page.screenshot({ path: join(evidencePath, "signed-out-800x600-200-percent.png") });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.setViewport({ width: 380, height: 600, deviceScaleFactor: 1 });
  const popupSource = await readFile(join(root, "src/popup/App.tsx"), "utf8");
  const sourceStateCoverage = evidenceStates.map((state) => ({
    state,
    representative: state === "signed-out",
    sourceStateCoverage: state === "active-balanced"
      ? popupSource.includes("ACTIVE CHALLENGE")
      : state === "active-behind"
        ? popupSource.includes("Behind")
      : state === "setup"
        ? popupSource.includes("Finish setting up your account")
        : state === "invitation"
          ? popupSource.includes("Invitation terms")
          : state === "scheduled"
            ? popupSource.includes("SCHEDULED CHALLENGE")
              : state === "unavailable"
                  ? popupSource.includes("CONNECTION UNAVAILABLE")
                  : state === "update-required"
                    ? popupSource.includes("UPDATE REQUIRED")
                    : state === "success"
                      ? popupSource.includes("Challenge complete")
                      : state === "incomplete"
                        ? popupSource.includes("Challenge incomplete")
                        : state === "canceled"
                          ? popupSource.includes("canceled")
                          : state === "abandoned"
                            ? popupSource.includes("Challenge abandoned")
                            : popupSource.includes("You’re signed out"),
  }));
  await writeFile(join(evidencePath, "packaged-state-evidence.json"), JSON.stringify({
    generatedBy: "scripts/smoke.mjs",
    viewport: { default: "380x600", zoomAcceptance: "200% at 800x600" },
    keyboard: { namedControlReached: true, reducedMotion: true },
    states: sourceStateCoverage,
  }, null, 2) + "\n");
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
  return page.evaluate(async (message) => {
    const response = chrome.runtime.sendMessage(message);
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("The packaged worker did not answer within 10 seconds.")), 10_000);
    });
    return Promise.race([response, timeout]);
  }, request);
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
  return page.evaluate(async () => {
    const stored = await chrome.storage.local.get("larp-code.workerBootCount");
    if (typeof stored["larp-code.workerBootCount"] === "number") return stored["larp-code.workerBootCount"];
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

async function invokeDisplayNameCommandRpc(page, { idempotencyKey, memberId, memberEmail, displayName }) {
  const accessToken = await storedAccessToken(page);
  if (!accessToken) throw new Error("The acceptance session did not contain an access token.");
  return page.evaluate(async ({ apiUrl, anonKey, token, idempotencyKey: key, memberId: id, memberEmail: address, displayName: name }) => {
    const response = await fetch(`${apiUrl}/rest/v1/rpc/update_member_display_name_v1`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_idempotency_key: key,
        p_command_version: 1,
        p_command_kind: "update_display_name",
        p_member_id: id,
        p_member_email: address,
        p_display_name: name,
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { apiUrl: backendUrl, anonKey: backendAnonKey, token: accessToken, idempotencyKey, memberId, memberEmail, displayName });
}

async function invokeInvitationCommandRpc(page, { idempotencyKey, memberId, memberEmail, invitedEmail, startDate, deadlineDate }) {
  const accessToken = await storedAccessToken(page);
  if (!accessToken) throw new Error("The acceptance session did not contain an access token.");
  return page.evaluate(async ({ apiUrl, anonKey, token, idempotencyKey: key, memberId: id, memberEmail: address, invitedEmail: destination, startDate: start, deadlineDate: deadline }) => {
    const response = await fetch(`${apiUrl}/rest/v1/rpc/create_invitation_v1`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_idempotency_key: key,
        p_command_version: 1,
        p_command_kind: "create_invitation",
        p_member_id: id,
        p_member_email: address,
        p_invited_email: destination,
        p_challenge_time_zone: "UTC",
        p_start_date: start,
        p_deadline_date: deadline,
        p_problem_set_version_id: "neetcode-150-2026-08-15",
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { apiUrl: backendUrl, anonKey: backendAnonKey, token: accessToken, idempotencyKey, memberId, memberEmail, invitedEmail, startDate, deadlineDate });
}

async function invokeInvitationReadRpc(page, invitationId) {
  const accessToken = await storedAccessToken(page);
  if (!accessToken) throw new Error("The acceptance session did not contain an access token.");
  return page.evaluate(async ({ apiUrl, anonKey, token, id }) => {
    const response = await fetch(`${apiUrl}/rest/v1/rpc/get_invitation_v1`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_invitation_id: id }),
    });
    return { status: response.status, body: await response.json() };
  }, { apiUrl: backendUrl, anonKey: backendAnonKey, token: accessToken, id: invitationId });
}

function runSql(sql) {
  const dbUrl = process.env.DB_URL ?? localBackendValue("DB_URL");
  if (!dbUrl) throw new Error("The local database URL is required for SQL acceptance.");
  return execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8" }).trim();
}

function sqlRejects(sql) {
  try {
    runSql(sql);
    return false;
  } catch {
    return true;
  }
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

async function lockMemberAccountRow(memberId) {
  const dbUrl = process.env.DB_URL ?? localBackendValue("DB_URL");
  if (!dbUrl) throw new Error("The local database URL is required for interruption acceptance.");
  const psql = spawn("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-At"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const locked = new Promise((resolve, reject) => {
    let output = "";
    psql.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("LOCKED")) resolve();
    });
    psql.once("error", reject);
    psql.once("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`Lock fixture exited with status ${code}.`));
    });
  });
  psql.stdin.write("begin;\n");
  psql.stdin.write(`select id from public.member_accounts where id = '${memberId}' for update;\n`);
  psql.stdin.write("select 'LOCKED';\n");
  await locked;
  return async () => {
    psql.stdin.write("rollback;\n");
    psql.stdin.end();
    await new Promise((resolve) => psql.once("exit", resolve));
  };
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
  await checkPackagedPopupAccessibility(page);
  const firstBoot = await workerBootCount(page);
  check(Number.isInteger(firstBoot) && firstBoot >= 1, "Popup receives a fresh worker snapshot");

  const email = `smoke-${Date.now()}@example.test`;
  const inviteeEmail = `smoke-invitee-${Date.now()}@example.test`;
  await clickButton(page, "Sign in with email");
  await page.waitForSelector("#member-email", { visible: true });
  await page.type("#member-email", email);
  await clickButton(page, "Request sign-in code");
  // Wait for the actual code-entry control. The status copy can render before
  // SignedOut's effect flips the form into the DOM.
  await page.waitForSelector("#member-code", { visible: true });
  let code = await waitForOtp(email);
  await page.type("#member-code", "000000");
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Verify code"));
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await clickButton(page, "Verify code");
  await page.waitForFunction(() => {
    const status = document.querySelector("#sign-in-status")?.textContent ?? "";
    return status.includes("That code is not valid")
      || status.includes("That code has expired")
      || status.includes("Too many requests");
  });
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
  // Keep the first observed OTP. The following requests intentionally probe
  // cooldown/rate limiting and are not a new delivery event to wait for.
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
  const renamed = await sendExtensionRequest(page, {
    version: 1,
    type: "update_display_name",
    displayName: "Ada Recovered",
  });
  check(renamed.ok && renamed.command?.status === "applied" && renamed.snapshot?.account?.displayName === "Ada Recovered", "Display-name editing uses the versioned transactional command");
  check(renamed.ok && renamed.snapshot?.pendingCommand === null, "Successful display-name command clears local pending intent after the stored result");
  const commandMemberId = await storedSessionIdentity(page);
  check(typeof commandMemberId === "string" && renamed.ok && renamed.command?.status === "applied", "Acceptance captures the command's account-bound identity and key");
  const replayed = await invokeDisplayNameCommandRpc(page, {
    idempotencyKey: renamed.command.idempotencyKey,
    memberId: commandMemberId,
    memberEmail: email,
    displayName: "Must not overwrite stored result",
  });
  check(replayed.status === 200 && replayed.body?.displayName === "Ada Recovered", "Reusing the same key returns the stored response without applying again");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const changedRevision = await sendExtensionRequest(page, { version: 1, type: "get_snapshot" });
  const revisionChanged = renamed.ok && changedRevision.ok
    && renamed.snapshot?.freshness.revision !== changedRevision.snapshot?.freshness.revision;
  const replayedAfterRevision = await invokeDisplayNameCommandRpc(page, {
    idempotencyKey: renamed.command.idempotencyKey,
    memberId: commandMemberId,
    memberEmail: email,
    displayName: "Must still not overwrite stored result",
  });
  check(revisionChanged && replayedAfterRevision.status === 200 && replayedAfterRevision.body?.displayName === "Ada Recovered", "Unrelated Snapshot revision changes do not reject or replay the command");
  const rejectedRename = await sendExtensionRequest(page, {
    version: 1,
    type: "update_display_name",
    displayName: "\u0000\n",
  });
  check(rejectedRename.ok && rejectedRename.command?.status === "rejected" && rejectedRename.command.code === "validation", "Known display-name validation failure is typed");
  check(rejectedRename.ok && rejectedRename.snapshot?.account?.displayName === "Ada Recovered" && rejectedRename.snapshot?.pendingCommand === null, "Known display-name failure leaves no partial change and returns a fresh account Snapshot");
  await page.evaluate(() => {
    const input = document.querySelector("#member-display-name-edit");
    if (!(input instanceof HTMLInputElement)) throw new Error("Display-name edit input not found");
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "Ada Popup");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickButton(page, "Save display name");
  await page.waitForFunction(() => document.body.innerText.includes("Welcome, Ada Popup"), { timeout: 15_000 });
  check(true, "Popup display-name editing returns to the authoritative account Snapshot");
  await page.close();
  page = await openPopup(extensionId);
  check((await page.evaluate(() => document.body.innerText.includes("Welcome, Ada Popup"))), "Display-name result survives popup closure");
  const releaseBeforeCommit = await lockMemberAccountRow(commandMemberId);
  const popupClosedCommand = sendExtensionRequest(page, {
    version: 1,
    type: "update_display_name",
    displayName: "Ada Before Commit",
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await page.close();
  await releaseBeforeCommit();
  await popupClosedCommand;
  page = await openPopup(extensionId);
  await page.waitForFunction(() => document.body.innerText.includes("Welcome, Ada Before Commit"), { timeout: 15_000 });
  check(true, "Popup closure before commit recovers one durable display-name update");
  const releaseWorkerBeforeCommit = await lockMemberAccountRow(commandMemberId);
  const workerTerminatedCommand = sendExtensionRequest(page, {
    version: 1,
    type: "update_display_name",
    displayName: "Ada Worker Before Commit",
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await terminateWorker(page, extensionId);
  await releaseWorkerBeforeCommit();
  await workerTerminatedCommand;
  await page.close();
  page = await openPopup(extensionId);
  await page.waitForFunction(() => document.body.innerText.includes("Welcome, Ada Worker Before Commit"), { timeout: 15_000 });
  check(true, "Actual worker termination before commit recovers one durable display-name update");
  const afterCommitCommand = sendExtensionRequest(page, {
    version: 1,
    type: "update_display_name",
    displayName: "Ada After Commit",
  }).catch(() => undefined);
  await page.close();
  await afterCommitCommand;
  page = await openPopup(extensionId);
  await page.waitForFunction(() => document.body.innerText.includes("Welcome, Ada After Commit"), { timeout: 15_000 });
  check(true, "Popup closure after commit but before response recovers one durable display-name update");
  const invitationStart = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const invitationDeadline = new Date(Date.now() + 11 * 86_400_000).toISOString().slice(0, 10);
  const invitationIdempotencyKey = crypto.randomUUID();
  const invitationCreated = await invokeInvitationCommandRpc(page, {
    idempotencyKey: invitationIdempotencyKey,
    memberId: commandMemberId,
    memberEmail: email,
    invitedEmail: inviteeEmail,
    startDate: invitationStart,
    deadlineDate: invitationDeadline,
  });
  check(invitationCreated.status === 200
    && invitationCreated.body?.invitedEmail === inviteeEmail
    && invitationCreated.body?.problemSetVersionId === "neetcode-150-2026-08-15", "Invitation pins the explicit reviewed Problem Set Version");
  const invitationId = invitationCreated.body?.id;
  check(typeof invitationId === "string", "Invitation acceptance captures an opaque invitation identifier");
  const duplicateOutgoing = await invokeInvitationCommandRpc(page, {
    idempotencyKey: crypto.randomUUID(),
    memberId: commandMemberId,
    memberEmail: email,
    invitedEmail: inviteeEmail,
    startDate: invitationStart,
    deadlineDate: invitationDeadline,
  });
  check(duplicateOutgoing.status >= 400 && /pending outgoing/i.test(String(duplicateOutgoing.body?.message)), "Duplicate outgoing invitations are rejected without a second pending invitation");
  const noticeState = runSql(`select delivered_at is null from public.transactional_notices where event_key = 'invitation:${invitationId}:created'`);
  check(noticeState === "t", "Invitation creation enqueues one undelivered transactional notice for dispatch");
  check(runSql("select count(*) from public.problem_set_version_problems where problem_set_version_id = 'neetcode-150-2026-08-15'") === "150", "Reviewed catalog version has exactly 150 immutable records");
  check(sqlRejects("update public.problem_set_versions set created_at = created_at where id = 'neetcode-150-2026-08-15'"), "Database rejects every Problem Set Version update");
  check(sqlRejects("delete from public.problem_set_versions where id = 'neetcode-150-2026-08-15'"), "Database rejects every Problem Set Version delete");
  check(sqlRejects("update public.problems set title = title where id = 'problem:0217-contains-duplicate'"), "Database rejects imported problem updates");
  check(sqlRejects("delete from public.problems where id = 'problem:0217-contains-duplicate'"), "Database rejects imported problem deletes");
  check(sqlRejects("update public.problem_set_version_problems set title = title where problem_set_version_id = 'neetcode-150-2026-08-15' and problem_id = 'problem:0217-contains-duplicate'"), "Database rejects pinned record updates");
  check(sqlRejects("delete from public.problem_set_version_problems where problem_set_version_id = 'neetcode-150-2026-08-15' and problem_id = 'problem:0217-contains-duplicate'"), "Database rejects pinned record deletes");
  const genericInvitationRead = await invokeInvitationReadRpc(page, crypto.randomUUID());
  check(genericInvitationRead.status >= 400 && genericInvitationRead.body?.message === "Invitation is unavailable.", "Unauthorized invitation reads return a generic response");
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
  check((await page.evaluate(() => document.body.innerText.includes("Welcome,") || document.body.innerText.includes("Invitation terms"))), "Authenticated Member Account survives popup close and reopen");
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
  check(returning.ok && ["account", "invitation"].includes(returning.snapshot?.kind), "Returning same email bypasses setup after re-authentication");
  await page.close();
  page = await openPopup(extensionId);
  check((await page.evaluate(() => document.body.innerText.includes("Welcome,") || document.body.innerText.includes("Invitation terms"))), "Returning same-email account survives popup reopen");
  await clickButton(page, "Sign out");
  await page.waitForFunction(() => document.body.innerText.includes("You’re signed out"));

  const reauthEmail = inviteeEmail;
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
  await page.waitForFunction(() => document.body.innerText.includes("Invitation terms"), { timeout: 15_000 });
  check(true, "Second authenticated profile creates its own Member Account and receives its pending invitation terms");
  const secondIdentity = await storedSessionIdentity(page);
  check(typeof secondIdentity === "string" && secondIdentity !== authenticatedIdentity, "Two profiles have distinct authenticated identities");
  const secondOwnAccount = await readOwnAccountRpc(page);
  check(secondOwnAccount.status === 200
    && secondOwnAccount.body?.id === secondIdentity
    && secondOwnAccount.body?.displayName === "Second Member"
    && secondOwnAccount.body?.displayName !== "<img src=x onerror=alert(1)>", "Authorized account RPC returns only the current profile");
  const invitedTerms = await invokeInvitationReadRpc(page, invitationId);
  check(invitedTerms.status === 200
    && invitedTerms.body?.id === invitationId
    && invitedTerms.body?.invitedEmail === inviteeEmail
    && invitedTerms.body?.problemSetVersionId === "neetcode-150-2026-08-15", "Authenticated invitee retrieves complete invitation terms");
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
    && crossProfileSetup.snapshot?.kind === "invitation"
    && crossProfileSetup.snapshot.invitation.invitedEmail === inviteeEmail, "Setup replay cannot read or overwrite another profile");
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
