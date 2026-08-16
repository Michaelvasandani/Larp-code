import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, "dist");
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
let profilePath;

function check(condition, message) {
  if (!condition) throw new Error(`Smoke check failed: ${message}`);
  console.log(`PASS  ${message}`);
}

async function extensionIdFromTarget() {
  const target = browser.targets().find((candidate) => candidate.type() === "service_worker");
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
    () => document.body.innerText.includes("You’re signed out"),
    { timeout: 15_000 },
  );
  return page;
}

async function workerBootCount(page) {
  return page.evaluate(() => {
    const values = [...document.querySelectorAll(".snapshot-details dd")].map((element) => element.textContent);
    return Number(values[1]);
  });
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
  await page.close();
  page = await openPopup(extensionId);
  await terminateWorker(page, extensionId);
  await page.close();
  page = await openPopup(extensionId);
  const restartedBoot = await workerBootCount(page);
  check(restartedBoot > firstBoot, "Actual service worker termination is recoverable");
  await page.close();
  console.log("Smoke OK: popup close/open and service-worker terminate/restart passed.");
} finally {
  if (browser) await browser.close();
  if (profilePath) await rm(profilePath, { recursive: true, force: true });
}
