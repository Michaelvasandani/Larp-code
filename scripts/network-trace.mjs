import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function realtimeOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
}

function exactOrigin(value) {
  const url = new URL(value);
  if (!/[a-z]+:/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error(`trace origin is not exact: ${value}`);
  return url.origin;
}

export function validateNetworkTrace(trace, options = {}) {
  if (!trace || trace.version !== 1 || !Array.isArray(trace.requests)) throw new Error("network trace schema is invalid");
  const backendOrigin = exactOrigin(options.expectedOrigin ?? trace.backendOrigin);
  const allowed = new Set([backendOrigin, realtimeOrigin(backendOrigin)]);
  const forbidden = /(?:leetcode|neetcode|google-analytics|doubleclick|segment|amplitude|mixpanel|sentry)/i;
  for (const request of trace.requests) {
    if (!request || typeof request.url !== "string") throw new Error("network trace request is missing a URL");
    if (forbidden.test(request.url)) throw new Error(`network trace contains platform or tracking traffic: ${request.url}`);
    const parsed = new URL(request.url);
    if (!allowed.has(parsed.origin)) throw new Error(`network trace contains undeclared origin: ${parsed.origin}`);
    if (/[?&](?:access_token|apikey|api_key|token)=/i.test(parsed.search)) throw new Error("network trace contains credential-like query material");
  }
  if (options.release && (trace.environment !== "production-controlled" || trace.productionEvidence !== true)) {
    throw new Error("release qualification requires a production-controlled, positively attested network trace");
  }
  return { backendOrigin, requests: trace.requests.length };
}

export async function captureNetworkTrace({ extensionPath, chromePath, backendOrigin, output, environment = "local-controlled", productionEvidence = false }) {
  const { default: puppeteer } = await import("puppeteer-core");
  const requests = [];
  const browser = await puppeteer.launch({
    executablePath: chromePath ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: false,
    enableExtensions: [extensionPath],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    const record = (url, type) => { if (/^(?:https?:|wss?:)/i.test(url)) requests.push({ url, type }); };
    page.on("request", (request) => record(request.url(), request.resourceType()));
    const deadline = Date.now() + 15_000;
    let worker;
    while (!worker && Date.now() < deadline) {
      worker = browser.targets().find((target) => target.type() === "service_worker");
      if (!worker) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (worker) {
      const session = await worker.createCDPSession();
      await session.send("Network.enable");
      session.on("Network.requestWillBeSent", (event) => record(event.request.url, "service-worker"));
    }
    const extensionId = worker?.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (extensionId) {
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  } finally {
    await browser.close();
  }
  const trace = {
    version: 1,
    capturedBy: "scripts/network-trace.mjs",
    capturedAt: new Date().toISOString(),
    environment,
    productionEvidence,
    backendOrigin: exactOrigin(backendOrigin),
    requests,
  };
  validateNetworkTrace(trace, { expectedOrigin: backendOrigin, release: false });
  writeFileSync(resolve(output), `${JSON.stringify(trace, null, 2)}\n`);
  return trace;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (process.argv[2] === "capture") {
    const output = process.argv[3] ?? process.env.NETWORK_TRACE_OUTPUT;
    if (!output) throw new Error("network trace capture output path is required");
    await captureNetworkTrace({
      extensionPath: resolve(process.env.PUBLICATION_EXTENSION_PATH ?? "dist"),
      chromePath: process.env.CHROME_BIN,
      backendOrigin: process.env.PUBLICATION_BACKEND_ORIGIN ?? process.env.SUPABASE_URL,
      output,
      environment: process.env.NETWORK_TRACE_ENVIRONMENT ?? "local-controlled",
      productionEvidence: process.env.TRACE_PRODUCTION_ATTESTED === "1",
    });
    console.log(`Network trace captured: ${resolve(output)}`);
    process.exit(0);
  }
  const input = process.argv[2];
  if (!input || !existsSync(input)) throw new Error("network trace JSON path is required");
  const trace = JSON.parse(readFileSync(input, "utf8"));
  const result = validateNetworkTrace(trace, {
    expectedOrigin: process.env.PUBLICATION_BACKEND_ORIGIN ?? trace.backendOrigin,
    release: process.env.PUBLICATION_RELEASE === "1",
  });
  console.log(`Network trace OK: ${result.requests} requests, exact backend ${result.backendOrigin}`);
}
