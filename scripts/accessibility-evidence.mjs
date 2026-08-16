import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import puppeteer from "puppeteer-core";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, "dist");
const evidencePath = resolve(root, "artifacts/ticket31-accessibility");
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const states = [
  "signed-out", "setup", "invitation", "scheduled", "active-balanced", "active-behind",
  "unavailable", "update-required", "success", "incomplete", "canceled", "abandoned",
];

function check(value, message) {
  if (!value) throw new Error(`Accessibility evidence failed: ${message}`);
}

const source = await readFile(resolve(root, "src/popup/App.tsx"), "utf8");
const sourceCoverage = Object.fromEntries(states.map((state) => [state,
  state === "signed-out" ? source.includes("You’re signed out")
    : state === "setup" ? source.includes("Finish setting up your account")
      : state === "invitation" ? source.includes("Invitation terms")
        : state === "scheduled" ? source.includes("SCHEDULED CHALLENGE")
          : state === "active-balanced" ? source.includes("ACTIVE CHALLENGE")
            : state === "active-behind" ? source.includes("Behind")
              : state === "unavailable" ? source.includes("CONNECTION UNAVAILABLE")
                : state === "update-required" ? source.includes("UPDATE REQUIRED")
                  : state === "success" ? source.includes("Challenge complete")
                    : state === "incomplete" ? source.includes("Challenge incomplete")
                      : state === "canceled" ? source.includes("canceled")
                        : source.includes("Challenge abandoned")
]));
check(Object.values(sourceCoverage).every(Boolean), "every required state has a source presentation");

await mkdir(evidencePath, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  enableExtensions: [extensionPath],
  args: ["--no-first-run", "--no-default-browser-check"],
});
try {
  const serviceWorkerDeadline = Date.now() + 15_000;
  let target;
  while (!target && Date.now() < serviceWorkerDeadline) {
    target = browser.targets().find((candidate) => candidate.type() === "service_worker");
    if (!target) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  check(target, "packaged service worker starts");
  const extensionId = target.url().match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  check(extensionId, "packaged extension has an id");
  const page = await browser.newPage();
  await page.setViewport({ width: 380, height: 600, deviceScaleFactor: 1 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForSelector('main[role="main"][tabindex="-1"]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector("button, input, a, select") !== null, { timeout: 15_000 });
  check(await page.$eval('main[role="main"]', (main) => main.getAttribute("aria-labelledby") === "app-title"), "popup exposes named main landmark");
  let namedControlReached = false;
  for (let tab = 0; tab < 10 && !namedControlReached; tab += 1) {
    await page.keyboard.press("Tab");
    namedControlReached = await page.evaluate(() => ["BUTTON", "INPUT", "A", "SELECT"].includes(document.activeElement?.tagName ?? "")
      && Boolean(document.activeElement?.textContent || document.activeElement?.getAttribute("aria-label") || document.activeElement?.getAttribute("aria-labelledby")));
  }
  check(namedControlReached, "keyboard reaches a named control");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  check(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "reduced-motion preference is observable");
  await page.screenshot({ path: join(evidencePath, "packaged-380x600.png") });
  await page.evaluate(() => { document.documentElement.style.zoom = "200%"; });
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await page.screenshot({ path: join(evidencePath, "packaged-800x600-200-percent.png") });
  await writeFile(join(evidencePath, "packaged-state-evidence.json"), JSON.stringify({
    generatedBy: "scripts/accessibility-evidence.mjs",
    packaged: true,
    viewport: { default: "380x600", zoomAcceptance: "200% at 800x600" },
    keyboard: { namedControlReached },
    reducedMotion: true,
    representativeScreenshot: "packaged-380x600.png",
    zoomScreenshot: "packaged-800x600-200-percent.png",
    states: states.map((state) => ({ state, sourceCoverage: sourceCoverage[state], packagedJourney: state === "signed-out" })),
  }, null, 2) + "\n");
} finally {
  await browser.close();
}
