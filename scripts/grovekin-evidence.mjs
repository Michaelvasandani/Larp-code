import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const evidence = join(root, "artifacts/ticket36-grovekin");
const screenshots = join(evidence, "screenshots");
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const now = "2026-08-16T00:00:00.000Z";

if (!existsSync(join(dist, "popup.html"))) throw new Error("Build the packaged popup first with `pnpm build`.");
if (!existsSync(chromePath)) throw new Error(`Chrome executable not found at ${chromePath}.`);
mkdirSync(screenshots, { recursive: true });

function member(memberId, displayName, creditedTotal) {
  return {
    memberId,
    email: `${memberId}@example.test`,
    displayName,
    authority: "equal",
    creditedTotal,
    paceStatus: "on_pace_today",
    paceGap: {
      previousTarget: 4,
      currentTarget: 5,
      gapToPreviousTarget: 0,
      amountNeededToday: 0,
      amountAhead: 0,
      copy: "On pace for the shared target.",
    },
  };
}

function challenge(status = "active", solveHistory = []) {
  return {
    id: "challenge-evidence",
    invitationId: "invitation-evidence",
    timeZone: "UTC",
    startDate: "2026-08-16",
    deadlineDate: "2026-09-14",
    problemSetVersionId: "pinned",
    status,
    createdAt: now,
    members: [member("member-1", "Ada", 5), member("member-2", "Grace", 5)].map(({ memberId, email, displayName, authority }) => ({ memberId, email, displayName, authority })),
    ...(solveHistory.length > 0 ? { solveHistory } : {}),
  };
}

function activeSnapshot({ revision, stage, condition, pairProgress = 5, solveHistory = [] }) {
  return {
    contractVersion: 1,
    kind: "active",
    authoritativeServerTime: now,
    freshness: { revision, fetchedAt: now },
    compatibility: { minimumClientVersion: "0.1.0" },
    backend: { status: "reachable", schemaVersion: 1 },
    worker: { bootId: "evidence-boot", bootCount: 1, sessionRestoredFromStorage: true },
    challenge: challenge("active", solveHistory),
    progress: {
      problemSetVersionId: "pinned",
      day: 1,
      durationDays: 30,
      expectedProgress: 5,
      previousExpectedProgress: 4,
      earlierExpectedProgress: 3,
      pairProgress,
      petCondition: condition,
      currentEvolutionStage: stage,
      highestEvolutionStage: stage,
      members: [member("member-1", "Ada", 5), member("member-2", "Grace", 5)],
    },
    actions: ["solve", "abandon"],
  };
}

function solveHistory() {
  return [{
    id: "solve-evidence",
    memberId: "member-1",
    challengeId: "challenge-evidence",
    problemId: "array-1",
    claimedAt: now,
    creditStatus: "credited",
    originalCreditStatus: "credited",
    corrections: [],
  }];
}

function terminalSnapshot() {
  return {
    contractVersion: 1,
    kind: "terminal",
    authoritativeServerTime: now,
    freshness: { revision: "terminal-farewell", fetchedAt: now },
    compatibility: { minimumClientVersion: "0.1.0" },
    backend: { status: "reachable", schemaVersion: 1 },
    worker: { bootId: "evidence-boot", bootCount: 1, sessionRestoredFromStorage: true },
    challenge: {
      ...challenge("completed", solveHistory()),
      completionFarewellAt: now,
      finalTotals: [{ memberId: "member-1", creditedTotal: 150 }, { memberId: "member-2", creditedTotal: 150 }],
    },
    actions: [],
  };
}

const cases = {};
for (const stage of [1, 2, 3, 4]) {
  for (const condition of ["healthy", "hungry", "sad", "deteriorated"]) {
    cases[`stage-${stage}-${condition}`] = activeSnapshot({ revision: `matrix-${stage}-${condition}`, stage, condition });
  }
}
cases["idle-loop"] = activeSnapshot({ revision: "idle-loop", stage: 2, condition: "healthy" });
cases["solve-reaction"] = activeSnapshot({ revision: "solve-before", stage: 3, condition: "healthy" });
cases["evolution-before"] = activeSnapshot({ revision: "evolution-before", stage: 2, condition: "healthy" });
cases["farewell-before"] = activeSnapshot({ revision: "farewell-before", stage: 4, condition: "healthy", pairProgress: 149 });
cases["reduced-motion"] = activeSnapshot({ revision: "reduced-motion", stage: 4, condition: "deteriorated" });

const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = createServer((request, response) => {
  const requested = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/")).replace(/^\.\.(\/|\\)/, "");
  const relative = requested === "/" ? "/popup.html" : requested;
  const file = join(dist, relative);
  if (!file.startsWith(`${dist}/`) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" });
  response.end(readFileSync(file));
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const browser = await puppeteer.launch({ headless: true, executablePath: chromePath, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (message) => console.log(`[browser] ${message.text()}`));
page.on("pageerror", (error) => console.error(`[browser error] ${error.message}`));
page.on("requestfailed", (request) => console.error(`[request failed] ${request.url()} ${request.failure()?.errorText}`));
await page.setViewport({ width: 380, height: 600, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument((snapshotCases, serverOrigin) => {
  let messageListener;
  const runtime = {
    getURL: (path) => `${serverOrigin}/${path}`,
    sendMessage: async (request) => {
      if (request.type === "get_snapshot") {
        const name = new URL(window.location.href).searchParams.get("case") ?? "stage-1-healthy";
        return { ok: true, snapshot: window.__grovekinCurrentSnapshot ?? snapshotCases[name] };
      }
      if (request.type === "get_drafts" || request.type === "clear_draft") return { ok: true, drafts: {} };
      if (request.type === "save_draft") return { ok: true, draft: { kind: request.draft.kind, status: "saved" } };
      return { ok: true };
    },
    connect: () => ({
      onMessage: { addListener: (listener) => { messageListener = listener; }, removeListener: () => { messageListener = undefined; } },
      disconnect: () => undefined,
    }),
  };
  if (!window.chrome) window.chrome = {};
  Object.defineProperty(window.chrome, "runtime", { configurable: true, writable: true, value: runtime });
  window.__grovekinTrigger = (snapshot) => {
    window.__grovekinCurrentSnapshot = snapshot;
    if (messageListener) messageListener({ version: 1, type: "snapshot_invalidated" });
  };
}, cases, origin);

async function waitForPopup() {
  await page.waitForSelector(".state-card", { timeout: 5_000 });
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), { timeout: 5_000 });
  await page.evaluate(() => document.fonts.ready);
}

async function capture(name, caseName, delay = 0) {
  console.log(`Capturing ${name}`);
  await page.goto(`${origin}/popup.html?case=${encodeURIComponent(caseName)}`, { waitUntil: "networkidle0" });
  await waitForPopup();
  if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  await page.screenshot({ path: join(screenshots, `${name}.png`) });
}

for (const stage of [1, 2, 3, 4]) {
  for (const condition of ["healthy", "hungry", "sad", "deteriorated"]) {
    await capture(`active-stage-${stage}-${condition}`, `stage-${stage}-${condition}`);
  }
}
await capture("playback-stage-2-idle-blink", "idle-loop", 820);
await capture("playback-solve-stage-3", "solve-reaction");
await page.evaluate((snapshot) => window.__grovekinTrigger(snapshot), activeSnapshot({ revision: "solve-after", stage: 3, condition: "healthy", pairProgress: 6, solveHistory: solveHistory() }));
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
await page.screenshot({ path: join(screenshots, "playback-solve-stage-3-reaction.png") });
await capture("playback-evolution-stage-2-to-3-before", "evolution-before");
await page.evaluate((snapshot) => window.__grovekinTrigger(snapshot), activeSnapshot({ revision: "evolution-after", stage: 3, condition: "healthy" }));
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
await page.screenshot({ path: join(screenshots, "playback-evolution-stage-2-to-3.png") });
await capture("playback-farewell-stage-4-before", "farewell-before");
await page.evaluate((snapshot) => window.__grovekinTrigger(snapshot), terminalSnapshot());
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
await page.screenshot({ path: join(screenshots, "playback-stage-4-farewell-transient.png") });
await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
await capture("reduced-motion-stage-4-deteriorated-static", "reduced-motion");

await browser.close();
await new Promise((resolvePromise) => server.close(resolvePromise));
console.log(`Captured Grovekin evidence under ${screenshots}`);
