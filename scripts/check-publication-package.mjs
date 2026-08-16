import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exactOrigin, isReservedOrigin } from "./release-contract.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function failure(message) {
  throw new Error(`Publication package check failed: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) failure(message);
}

function filesIn(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    const relativePath = relative(directory, path).replaceAll("\\", "/");
    if (stat.isSymbolicLink()) failure(`archive contains symlink after extraction: ${relativePath}`);
    if (stat.isDirectory()) files.push(...filesIn(path));
    else if (stat.isFile()) files.push(path);
    else failure(`archive contains non-regular entry after extraction: ${relativePath}`);
  }
  return files;
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { failure(`${label} is not valid JSON: ${error.message}`); }
}

function realtimeOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeArchiveName(name) {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) failure(`archive contains absolute path: ${name}`);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..")) failure(`archive contains path traversal: ${name}`);
  return normalized;
}

function preflightArchive(archive) {
  const stat = lstatSync(archive);
  requireCondition(stat.isFile(), "archive input must be a regular file");
  let names;
  try {
    names = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").map((name) => name.trim()).filter(Boolean);
  } catch (error) {
    failure(`could not inspect ZIP before extraction: ${error.message}`);
  }
  const seen = new Set();
  for (const name of names) {
    const normalized = safeArchiveName(name);
    requireCondition(!seen.has(normalized), `archive contains duplicate entry: ${name}`);
    seen.add(normalized);
  }
  let verbose;
  try {
    verbose = execFileSync("unzip", ["-Z", "-v", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    failure(`could not inspect ZIP entry attributes: ${error.message}`);
  }
  for (const match of verbose.matchAll(/Unix file attributes \([0-7]+ octal\):\s+([a-z-])/g)) {
    requireCondition(match[1] === "-" || match[1] === "d", "archive contains symlink or non-regular entry");
  }
  return names;
}

function ensureContained(root, path, label) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  requireCondition(resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`), `${label} escapes package root`);
}

function extractArchive(archive) {
  preflightArchive(archive);
  const directory = mkdtempSync(join(tmpdir(), "larp-code-publication-"));
  try {
    execFileSync("unzip", ["-q", "-X", archive, "-d", directory], { stdio: "pipe" });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    failure(`could not unpack ZIP: ${error.message}`);
  }
  ensureContained(directory, directory, "extraction root");
  return directory;
}

function sourceOnlyFile(path) {
  const extension = extname(path).toLowerCase();
  return [".ts", ".tsx", ".mjs", ".map", ".env", ".md", ".sql"].includes(extension)
    || basename(path).startsWith(".")
    || /(^|\/)(tests?|art|scripts|src|supabase|node_modules)(\/|$)/.test(path);
}

function checkNoSecrets(files, packageRoot) {
  const prohibited = [
    /development-only-key/i,
    /SUPABASE_SERVICE_ROLE_KEY/i,
    /service_role/i,
    /(?:^|[^a-z])(?:sk|rk)_(?:live|test)_[a-z0-9_]+/i,
    /(?:^|[^a-z])re_[a-z0-9_]{16,}/i,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
    /postgres(?:ql)?:\/\//i,
    /TRANSACTIONAL_(?:DISPATCH_SECRET|MAIL_TRANSPORT)/i,
    /SCHEDULED_WORK_SECRET/i,
    /RESEND_API_KEY/i,
  ];
  for (const file of files) {
    if (![".js", ".html", ".css", ".json", ".txt"].includes(extname(file).toLowerCase())) continue;
    const source = readFileSync(file, "utf8");
    for (const pattern of prohibited) requireCondition(!pattern.test(source), `${relative(packageRoot, file)} contains prohibited secret/development material (${pattern})`);
  }
}

function checkNetworkCode(javascriptFiles, packageRoot, backendOrigin) {
  const allowedRealtime = realtimeOrigin(backendOrigin);
  const directNetworkCall = /(?:fetch|WebSocket|XMLHttpRequest|EventSource|createClient)\s*\(|(?:\.connect|\.channel)\s*\(/;
  const urls = /https?:\/\/[^\s"'`<>)}\]]+/gi;
  const forbiddenPlatform = /https?:\/\/(?:www\.)?(?:leetcode\.com|neetcode\.io|neetcode\.com)/i;
  for (const file of javascriptFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(urls)) {
      const value = match[0].replace(/[),.;]+$/, "");
      const context = source.slice(Math.max(0, match.index - 180), Math.min(source.length, match.index + value.length + 40));
      if (!directNetworkCall.test(context)) continue;
      requireCondition(!forbiddenPlatform.test(value), `${relative(packageRoot, file)} contains a platform network call`);
      let origin;
      try { origin = new URL(value).origin; } catch { continue; }
      requireCondition(origin === backendOrigin || origin === allowedRealtime, `${relative(packageRoot, file)} calls undeclared origin ${origin}`);
    }
  }
}

function checkGrovekin(packageRoot, files) {
  const grovekinRoot = join(packageRoot, "assets/grovekin");
  const manifestPath = join(grovekinRoot, "manifest.json");
  requireCondition(files.includes(manifestPath), "generated Grovekin manifest is missing");
  const manifest = readJson(manifestPath, "Grovekin manifest");
  requireCondition(Array.isArray(manifest.clips) && manifest.clips.length >= 10, "Grovekin clip inventory is incomplete");
  requireCondition(Array.isArray(manifest.frames) && manifest.frames.length >= 20, "Grovekin animation frames are missing");
  requireCondition(typeof manifest.animationChecksums === "string", "Grovekin animation checksum path is missing");
  const checksumPath = join(grovekinRoot, manifest.animationChecksums);
  requireCondition(existsSync(checksumPath), "Grovekin animation checksum file is missing");
  const checksumRows = readFileSync(checksumPath, "utf8").trim().split("\n").filter(Boolean);
  const checksums = new Map(checksumRows.map((row) => {
    const [hash, file] = row.trim().split(/\s+/, 2);
    return [file, hash];
  }));
  for (const frame of manifest.frames) {
    const path = join(grovekinRoot, frame.file);
    requireCondition(existsSync(path), `Grovekin frame is not packaged: ${frame.file}`);
    requireCondition(checksums.get(frame.file) === sha256(path), `Grovekin checksum mismatch: ${frame.file}`);
  }
  requireCondition(existsSync(join(grovekinRoot, "spritesheet/grovekin-animations.png")), "Grovekin animation sheet is missing");
}

function checkListingAssets(packageRoot) {
  for (const [path, width, height] of [["icons/icon-16.png", 16, 16], ["icons/icon-48.png", 48, 48], ["icons/icon-128.png", 128, 128]]) {
    const file = join(packageRoot, path);
    requireCondition(existsSync(file), `static toolbar icon is missing: ${path}`);
    const bytes = readFileSync(file);
    requireCondition(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${path} is not a PNG`);
    requireCondition(bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height, `${path} has unexpected dimensions`);
  }
}

function checkPublicSurfaces(packageRoot) {
  const legalPath = join(packageRoot, "legal.html");
  const privacyPath = join(packageRoot, "privacy.html");
  requireCondition(existsSync(legalPath) && existsSync(privacyPath), "public legal/privacy pages are missing");
  const legal = readFileSync(legalPath, "utf8");
  const privacy = readFileSync(privacyPath, "utf8");
  requireCondition(legal.includes("MIT License") && legal.includes("Copyright (c) 2022 neetcode-gh"), "complete catalog MIT notice is missing");
  requireCondition(legal.includes("not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode"), "exact non-affiliation notice is missing");
  requireCondition(/href=["']privacy\.html["']/i.test(legal), "Legal page does not link the public privacy policy");
  for (const phrase of ["chrome.storage.local", "Supabase", "transactional", "retention", "delete", "HTTPS/WSS", "support route", "never fetches, scrapes, previews, or injects"]) {
    requireCondition(privacy.toLowerCase().includes(phrase.toLowerCase()), `privacy policy omits ${phrase}`);
  }
  for (const href of [...legal.matchAll(/href=["']([^"']+)["']/gi), ...privacy.matchAll(/href=["']([^"']+)["']/gi)].map((match) => match[1])) {
    if (href.startsWith("http://") || href.startsWith("https://")) continue;
    if (href.startsWith("#")) continue;
    requireCondition(existsSync(join(packageRoot, href)), `public page links to missing packaged file ${href}`);
  }
}

export async function validatePublicationPackage(inputPath, options = {}) {
  const input = resolve(inputPath);
  requireCondition(existsSync(input), `input does not exist: ${input}`);
  const archive = extname(input).toLowerCase() === ".zip";
  const packageRoot = archive ? extractArchive(input) : input;
  try {
    const files = filesIn(packageRoot);
    for (const file of files) ensureContained(packageRoot, file, `extracted file ${relative(packageRoot, file)}`);
    const relativeFiles = files.map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
    requireCondition(relativeFiles.includes("manifest.json"), "manifest.json must be at the archive root");
    requireCondition(!relativeFiles.some(sourceOnlyFile), "source-only or development files are packaged");
    requireCondition(!relativeFiles.some((file) => file.startsWith("../") || file.includes("/../")), "archive contains path traversal");
    checkNoSecrets(files, packageRoot);

    const manifest = readJson(join(packageRoot, "manifest.json"), "manifest");
    requireCondition(manifest.manifest_version === 3, "manifest is not Manifest V3");
    requireCondition(JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]), "permissions exceed storage");
    requireCondition(!manifest.content_scripts && !manifest.web_accessible_resources && !manifest.offscreen_documents, "extra extension contexts/resources are packaged");
    requireCondition(manifest.action?.default_popup === "popup.html", "popup is not popup.html");
    requireCondition(manifest.background?.service_worker === "service-worker.js" && manifest.background?.type === "module", "worker is not a packaged module service worker");
    const hostPermissions = manifest.host_permissions ?? [];
    requireCondition(hostPermissions.length === 1 && typeof hostPermissions[0] === "string", "exactly one host permission is required");
    const hostPattern = hostPermissions[0];
    requireCondition(hostPattern.endsWith("/*") && !hostPattern.slice(0, -2).includes("*"), "host permission is broad");
    const backendOrigin = exactOrigin(hostPattern.slice(0, -2));
    requireCondition(backendOrigin, "host permission is not an exact origin");
    const expectedOrigin = options.expectedOrigin ? exactOrigin(options.expectedOrigin) : backendOrigin;
    requireCondition(options.allowLocal || backendOrigin === expectedOrigin, `candidate origin ${backendOrigin} does not match expected release origin ${expectedOrigin}`);
    requireCondition(options.allowLocal || new URL(backendOrigin).protocol === "https:", "publication candidate must use HTTPS");
    requireCondition(!options.release || !isReservedOrigin(backendOrigin), "release candidate uses a reserved, local, example, or placeholder origin");
    const csp = String(manifest.content_security_policy?.extension_pages ?? "");
    requireCondition(csp.includes("script-src 'self'") && csp.includes("object-src 'self") && !csp.includes("unsafe-eval") && !csp.includes("unsafe-inline"), "CSP permits unsafe code");
    requireCondition(csp.includes(`connect-src 'self'`) && csp.includes(backendOrigin) && csp.includes(realtimeOrigin(backendOrigin)), "CSP does not disclose exact API and Realtime origins");
    requireCondition(manifest.action?.default_icon?.["16"] === "icons/icon-16.png" && manifest.action?.default_icon?.["48"] === "icons/icon-48.png" && manifest.action?.default_icon?.["128"] === "icons/icon-128.png", "static toolbar icon inventory is incomplete");

    const javascriptFiles = files.filter((file) => extname(file).toLowerCase() === ".js");
    requireCondition(javascriptFiles.some((file) => relative(packageRoot, file) === "service-worker.js"), "service worker bundle is missing");
    requireCondition(javascriptFiles.length >= 2, "popup and worker executable bundles are missing");
    for (const file of javascriptFiles) {
      const source = readFileSync(file, "utf8");
      requireCondition(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(source), `${relative(packageRoot, file)} uses dynamic code execution`);
      requireCondition(!/\bimport\s*\(|\bimportScripts\s*\(/.test(source), `${relative(packageRoot, file)} loads remote or runtime code`);
      requireCondition(!source.includes("chrome.storage.sync"), `${relative(packageRoot, file)} uses Chrome Sync storage`);
      requireCondition(!/<script(?:\s[^>]*)?>[\s\S]*<\/script>/i.test(source), `${relative(packageRoot, file)} contains executable HTML`);
    }
    checkNetworkCode(javascriptFiles, packageRoot, backendOrigin);
    const popup = readFileSync(join(packageRoot, "popup.html"), "utf8");
    requireCondition(!/<script[^>]*>(?!\s*<\/script>)[\s\S]*<\/script>/i.test(popup), "popup contains inline script code");
    const scriptSources = [...popup.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((match) => match[1].replace(/^\//, ""));
    requireCondition(scriptSources.length > 0 && scriptSources.every((source) => relativeFiles.includes(source)), "popup references an unpackaged script");
    checkGrovekin(packageRoot, files);
    checkListingAssets(packageRoot);
    checkPublicSurfaces(packageRoot);
    return { files: relativeFiles.length, backendOrigin, sha256: archive ? sha256(input) : null };
  } finally {
    if (archive) rmSync(packageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] ?? join(repositoryRoot, "dist");
  const expectedOrigin = process.env.PUBLICATION_BACKEND_ORIGIN ?? process.env.SUPABASE_URL;
  const allowLocal = process.env.ALLOW_LOCAL_PUBLICATION === "1";
  const result = await validatePublicationPackage(input, { expectedOrigin, allowLocal });
  console.log(`Publication package OK: ${result.files} files, exact backend ${result.backendOrigin}`);
}
