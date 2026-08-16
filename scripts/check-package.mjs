import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");

function fail(message) {
  throw new Error(`Package check failed: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(path);
  }
  return files;
}

const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
requireCondition(manifest.manifest_version === 3, "manifest is not Manifest V3");
requireCondition(manifest.action?.default_popup === "popup.html", "action popup is not popup.html");
requireCondition(manifest.background?.service_worker === "service-worker.js", "worker is not packaged at the root");
requireCondition(manifest.background?.type === "module", "worker must be an event-driven module");
requireCondition(JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]), "permissions exceed storage");
requireCondition(!manifest.content_scripts && !manifest.offscreen_documents, "alternate extension contexts are packaged");
requireCondition(!("persistent" in (manifest.background ?? {})), "persistent background behavior is packaged");

const hostPermissions = manifest.host_permissions ?? [];
requireCondition(hostPermissions.length === 1, "the package must allow exactly one backend origin");
const backendPattern = String(hostPermissions[0]);
const backendOrigin = backendPattern.endsWith("/*") ? backendPattern.slice(0, -2) : "";
const parsedOrigin = backendOrigin ? new URL(backendOrigin) : null;
requireCondition(Boolean(parsedOrigin) && (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:"), "backend origin is invalid");
requireCondition(!backendOrigin.includes("*") && parsedOrigin.pathname === "/" && !parsedOrigin.search && !parsedOrigin.hash, "backend permission is broad");

const csp = String(manifest.content_security_policy?.extension_pages ?? "");
requireCondition(csp.includes("script-src 'self'") && csp.includes("object-src 'self'"), "CSP does not require packaged scripts/objects");
requireCondition(!csp.includes("unsafe-eval") && !csp.includes("unsafe-inline"), "CSP permits unsafe executable content");
requireCondition(csp.includes(backendOrigin), "CSP does not allow the configured backend origin");
const realtimeOrigin = `${parsedOrigin.protocol === "https:" ? "wss" : "ws"}://${parsedOrigin.host}`;
requireCondition(csp.includes(realtimeOrigin), "CSP does not allow the exact corresponding Realtime origin");

const files = await filesIn(dist);
const grovekinManifestPath = join(dist, "assets/grovekin/manifest.json");
requireCondition(files.includes(grovekinManifestPath), "generated Grovekin manifest is missing from the package");
const grovekinManifest = JSON.parse(await readFile(grovekinManifestPath, "utf8"));
requireCondition(Array.isArray(grovekinManifest.clips) && grovekinManifest.clips.length >= 10, "Grovekin clip inventory is incomplete");
requireCondition(Array.isArray(grovekinManifest.frames) && grovekinManifest.frames.length >= 20, "Grovekin animation frames are missing");
requireCondition(files.includes(join(dist, "assets/grovekin", grovekinManifest.animationChecksums)), "Grovekin animation checksums are missing");
for (const frame of grovekinManifest.frames) {
  requireCondition(files.includes(join(dist, "assets/grovekin", frame.file)), `Grovekin frame is not packaged: ${frame.file}`);
}
const javascriptFiles = files.filter((file) => extname(file) === ".js");
requireCondition(javascriptFiles.some((file) => relative(dist, file) === "service-worker.js"), "service worker bundle is missing");
requireCondition(javascriptFiles.length >= 2, "popup and worker executable bundles are missing");
requireCondition(!files.some((file) => extname(file) === ".map"), "source maps are included in the package");

for (const file of javascriptFiles) {
  const source = await readFile(file, "utf8");
  requireCondition(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(source), `${relative(dist, file)} uses dynamic code execution`);
  requireCondition(!source.includes("chrome.storage.sync"), `${relative(dist, file)} uses sync storage`);
  requireCondition(!/<script(?:\s[^>]*)?>[\s\S]*<\/script>/i.test(source), `${relative(dist, file)} contains HTML executable markup`);
}

const popup = await readFile(join(dist, "popup.html"), "utf8");
requireCondition(!/<script[^>]*>(?!\s*<\/script>)[\s\S]*<\/script>/i.test(popup), "popup contains inline script code");
const scriptSources = [...popup.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1].replace(/^\//, ""));
requireCondition(scriptSources.length > 0 && scriptSources.every((source) => files.includes(join(dist, source))), "popup references an un-packaged script");

console.log(`Package OK: ${files.length} files, exact backend ${backendOrigin}, permissions [storage]`);
