import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { exactOrigin, isReservedOrigin } from "./release-contract.mjs";

export const QUALIFICATION_SCHEMA_VERSION = 1;

export const GATE_DEFINITIONS = Object.freeze([
  { id: 0, name: "Specification integrity" },
  { id: 1, name: "Foundation contract" },
  { id: 2, name: "Domain correctness" },
  { id: 3, name: "End-to-end experience" },
  { id: 4, name: "Resilience and data governance" },
  { id: 5, name: "Assets and publication" },
  { id: 6, name: "Release candidate" },
]);

export const REQUIRED_EVIDENCE_AREAS = Object.freeze([
  "infrastructure",
  "mail",
  "monitoring",
  "recovery",
  "endToEnd",
]);

export const REQUIRED_PRIMARY_SOURCE_AUTHORITIES = Object.freeze([
  "chrome",
  "neetcode",
  "leetcode",
  "supabase",
  "resend",
]);

const HEX_40 = /^[a-f0-9]{40}$/i;
const HEX_64 = /^[a-f0-9]{64}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const STATUS_VALUES = new Set(["confirmed", "pending", "blocked", "not-provided"]);
const CONTROLLED_ENVIRONMENTS = new Set(["production-controlled", "release-controlled"]);
const PRIMARY_SOURCE_ALLOWLISTS = Object.freeze({
  chrome: Object.freeze({ host: "developer.chrome.com", paths: ["/docs/"] }),
  neetcode: Object.freeze({ host: "github.com", paths: ["/neetcode-gh/leetcode"] }),
  leetcode: Object.freeze({ host: "leetcode.com", paths: ["/", "/problems/"] }),
  supabase: Object.freeze({ host: "supabase.com", paths: ["/docs/"] }),
  resend: Object.freeze({ host: "resend.com", paths: ["/docs/"] }),
});

const RECORD_KEYS = Object.freeze([
  "schemaVersion", "recordId", "recordedAt", "status", "releaseEligible", "submissionPerformed", "submissionStatus",
  "candidate", "compatibility", "evidence", "primarySourceRechecks", "gates", "publisherControls", "ownerResidualRisk",
  "externalBlockers", "notes",
]);
const CANDIDATE_KEYS = Object.freeze([
  "packageVersion", "extensionVersion", "sourceCommit", "archivePath", "archiveSha256", "candidateBuildPath",
  "networkTracePath", "networkTraceSha256", "backendOrigin", "environment", "productionEvidence",
]);
const COMPATIBILITY_KEYS = Object.freeze([
  "snapshotContracts", "commandContracts", "minimumClientVersion", "catalogVersion", "catalogSourceRepository",
  "catalogSourceCommit", "catalogSha256", "backfillVersion", "art",
]);
const ART_KEYS = Object.freeze(["generatorRevision", "manifestSha256", "checksumsSha256", "animationChecksumsSha256"]);
const EVIDENCE_KEYS = Object.freeze(["status", "environment", "productionEvidence", "observedAt", "evidenceRefs", "checks", "credentialDisclosure", "evidenceBindings"]);
const PRIMARY_SOURCE_KEYS = Object.freeze(["authority", "url", "sourceType", "checkedAt", "constraint", "result"]);
const GATE_KEYS = Object.freeze(["id", "name", "status", "codeComplete", "evidenceRefs", "observedChecks", "evidenceBindings"]);
const PUBLISHER_KEYS = Object.freeze(["developerAccount", "verifiedContactEmail", "twoStepVerification", "privacyUrl", "supportRoute"]);
const CONTROL_KEYS = Object.freeze(["status", "confirmedAt", "evidenceRef", "evidenceSha256"]);
const RISK_KEYS = Object.freeze(["status", "accepted", "acceptedBy", "acceptedAt", "scope", "legalAdvice", "rightsHolderAuthorizationClaimed"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  return canonical === normalized;
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function safeEvidenceRef(value) {
  if (!string(value)) return false;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return false;
  if (isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").includes("..") && !normalized.startsWith("/");
}

function firstPartySourceUrl(authority, value) {
  if (!httpsUrl(value)) return false;
  const allowlist = PRIMARY_SOURCE_ALLOWLISTS[authority];
  if (!allowlist) return false;
  const url = new URL(value);
  if (url.origin !== `https://${allowlist.host}`) return false;
  const pathname = url.pathname.endsWith("/") && url.pathname !== "/" ? url.pathname.slice(0, -1) : url.pathname;
  return url.hostname === allowlist.host && allowlist.paths.some((prefix) => {
    const normalizedPrefix = prefix.endsWith("/") && prefix !== "/" ? prefix.slice(0, -1) : prefix;
    return pathname === normalizedPrefix || (prefix.endsWith("/") && pathname.startsWith(normalizedPrefix + "/"));
  });
}

function repositoryFile(root, reference, label, blockers) {
  if (!string(root)) {
    blockers.push(`${label} cannot be verified without a repository root`);
    return null;
  }
  if (!string(reference)) {
    blockers.push(`${label} reference is missing`);
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(reference)) {
    blockers.push(`${label} reference must be a verifiable local artifact: ${reference}`);
    return null;
  }
  if (!safeEvidenceRef(reference)) {
    blockers.push(`${label} reference is missing or unsafe: ${reference}`);
    return null;
  }
  let repositoryRoot;
  let candidate;
  let stat;
  try {
    repositoryRoot = realpathSync(resolve(root));
    candidate = resolve(root, reference);
    stat = lstatSync(candidate);
  } catch {
    blockers.push(`${label} reference is missing: ${reference}`);
    return null;
  }
  if (stat.isSymbolicLink()) {
    blockers.push(`${label} must be a regular non-symlink file: ${reference}`);
    return null;
  }
  if (!stat.isFile()) {
    blockers.push(`${label} must be a regular non-symlink file`);
    return null;
  }
  let resolvedCandidate;
  try { resolvedCandidate = realpathSync(candidate); } catch {
    blockers.push(`${label} reference cannot be resolved: ${reference}`);
    return null;
  }
  if (!(resolvedCandidate === repositoryRoot || resolvedCandidate.startsWith(`${repositoryRoot}${sep}`))) {
    blockers.push(`${label} reference escapes the repository: ${reference}`);
    return null;
  }
  return resolvedCandidate;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function add(blockers, condition, message) {
  if (!condition) blockers.push(message);
}

function schemaKeys(path) {
  if (path === "record") return RECORD_KEYS;
  if (path === "record.candidate") return CANDIDATE_KEYS;
  if (path === "record.compatibility") return COMPATIBILITY_KEYS;
  if (path === "record.compatibility.art") return ART_KEYS;
  if (path === "record.evidence") return REQUIRED_EVIDENCE_AREAS;
  if (/^record\.evidence\.[^.]+$/.test(path)) return EVIDENCE_KEYS;
  if (/^record\.evidence\.[^.]+\.checks$/.test(path)) return null;
  if (/^record\.evidence\.[^.]+\.evidenceBindings\[\]$/.test(path)) return ["ref", "sha256", "checks"];
  if (path === "record.primarySourceRechecks[]") return PRIMARY_SOURCE_KEYS;
  if (path === "record.gates[]") return GATE_KEYS;
  if (path === "record.publisherControls") return PUBLISHER_KEYS;
  if (/^record\.publisherControls\.[^.]+$/.test(path)) return CONTROL_KEYS;
  if (path === "record.ownerResidualRisk") return RISK_KEYS;
  if (/^record\.gates\[\]\.evidenceBindings\[\]$/.test(path)) return ["ref", "sha256", "checks"];
  if (/^record\.gates\[\]\.checks$/.test(path)) return null;
  return undefined;
}

function checkAllowedKeys(value, path, blockers) {
  if (Array.isArray(value)) {
    value.forEach((entry) => checkAllowedKeys(entry, `${path}[]`, blockers));
    return;
  }
  if (!object(value)) return;
  const allowed = schemaKeys(path);
  if (allowed === undefined) {
    blockers.push(`${path} has an unsupported object shape`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (allowed !== null && !allowed.includes(key)) blockers.push(`${path} contains an unknown field: ${key}`);
    checkAllowedKeys(value[key], `${path}.${key}`, blockers);
  }
}

function checkNoSecrets(value, path = "record", blockers = []) {
  if (typeof value === "string") {
    const prohibited = [
      /service[_ -]?role/i,
      /(?:^|[^a-z])(?:sk|rk)_(?:live|test)_[a-z0-9_]+/i,
      /(?:^|[^a-z])re_[a-z0-9]{16,}/i,
      /(?:^|[^a-z])eyJ[a-z0-9_-]{20,}/i,
      /postgres(?:ql)?:\/\//i,
      /(?:password|secret|credential|api[_ -]?key)\s*[:=]\s*[^\s,}]+/i,
      /\b(?:opaque|bearer|access|refresh)[\s_-]*token\b\s*[:=]\s*[^\s,;}\]]+/i,
      /\b(?:member|user|account|profile|submission|solution|problem|phone|address|birth(?:date)?|dob|username|handle)(?:[\s_-]*(?:data|id|email|name|number))?\b\s*[:=]\s*[^\s,;}\]]+/i,
      /\bopaque\b/i,
      /\b(?:member|user|account|profile)[\s_-]+data\b/i,
      /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
      /^\d{6}$/,
      /\b(?:otp|one[- ]time code|verification code)\D{0,12}\d{6}\b/i,
    ];
    if (prohibited.some((pattern) => pattern.test(value))) blockers.push(`${path} contains prohibited sensitive material`);
    return blockers;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkNoSecrets(entry, `${path}[${index}]`, blockers));
    return blockers;
  }
  if (object(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      if (/^(?:email|otp|token|password|secret|apiKey|serviceRoleKey|memberData|accessToken|refreshToken)$/i.test(key)) blockers.push(`${path}.${key} is a prohibited sensitive field`);
      checkNoSecrets(entry, `${path}.${key}`, blockers);
    });
  }
  return blockers;
}

function checkFreeFormText(record, blockers) {
  const fields = [];
  if (Array.isArray(record.notes)) record.notes.forEach((value, index) => fields.push([`record.notes[${index}]`, value]));
  if (Array.isArray(record.externalBlockers)) record.externalBlockers.forEach((value, index) => fields.push([`record.externalBlockers[${index}]`, value]));
  if (Array.isArray(record.primarySourceRechecks)) record.primarySourceRechecks.forEach((row, index) => fields.push([`record.primarySourceRechecks[${index}].constraint`, row?.constraint]));
  fields.push(["record.ownerResidualRisk.scope", record.ownerResidualRisk?.scope]);
  fields.push(["record.ownerResidualRisk.acceptedBy", record.ownerResidualRisk?.acceptedBy]);
  for (const [path, value] of fields) {
    if (typeof value !== "string") continue;
    add(blockers, value.length <= 500 && /^[\x20-\x7e\t\r\n]+$/.test(value), `${path} must be bounded printable text`);
    if (/(?:^|[\s:=])[A-Za-z0-9_-]{24,}(?=$|[\s,.;!?()[\]{}])/u.test(value)) blockers.push(`${path} contains prohibited sensitive material`);
  }
}

function gitCommitExists(root, commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function archiveJson(archive, entry, label, blockers) {
  try {
    const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n").map((name) => name.trim()).filter(Boolean);
    if (entries.filter((name) => name === entry).length !== 1) {
      blockers.push(`${label} must contain exactly one ${entry}`);
      return null;
    }
    return JSON.parse(execFileSync("unzip", ["-p", archive, entry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    blockers.push(`${label} has an invalid or unreadable ${entry}`);
    return null;
  }
}

function realtimeOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
}

function checkCandidate(record, options, blockers) {
  const candidate = object(record.candidate);
  add(blockers, candidate, "candidate identity is missing");
  if (!candidate) return;
  add(blockers, string(candidate.packageVersion) && SEMVER.test(candidate.packageVersion), "candidate package version is invalid");
  add(blockers, string(candidate.extensionVersion) && SEMVER.test(candidate.extensionVersion), "candidate extension version is invalid");
  add(blockers, candidate.packageVersion === candidate.extensionVersion, "candidate packageVersion and extensionVersion must match");
  add(blockers, HEX_40.test(candidate.sourceCommit ?? ""), "candidate source commit must be a full 40-character SHA");
  if (options.root && HEX_40.test(candidate.sourceCommit ?? "")) add(blockers, gitCommitExists(options.root, candidate.sourceCommit), "candidate source commit does not exist in the repository");
  add(blockers, HEX_64.test(candidate.archiveSha256 ?? ""), "candidate archive SHA-256 must be a full 64-character digest");
  add(blockers, string(candidate.archivePath) && safeEvidenceRef(candidate.archivePath), "candidate archive path is missing or unsafe");
  add(blockers, string(candidate.candidateBuildPath) && safeEvidenceRef(candidate.candidateBuildPath), "candidate metadata path is missing or unsafe");
  add(blockers, exactOrigin(candidate.backendOrigin), "candidate backend origin must be an exact HTTP(S) origin");
  add(blockers, ["local-controlled", "release-controlled", "production-controlled"].includes(candidate.environment), "candidate environment is not explicit");
  add(blockers, candidate.productionEvidence === true, "candidate lacks positive production-controlled evidence");
  if (candidate.productionEvidence === true) add(blockers, CONTROLLED_ENVIRONMENTS.has(candidate.environment), "candidate productionEvidence requires a release- or production-controlled environment");
  if (candidate.environment === "production-controlled") add(blockers, !isReservedOrigin(candidate.backendOrigin), "production candidate backend origin is reserved or not public");
  add(blockers, HEX_64.test(candidate.networkTraceSha256 ?? ""), "candidate network trace SHA-256 is missing or invalid");
  add(blockers, string(candidate.networkTracePath) && safeEvidenceRef(candidate.networkTracePath), "candidate network trace path is missing or unsafe");

  if (!candidate.archivePath || !options.root || !safeEvidenceRef(candidate.archivePath)) return;
  const archive = repositoryFile(options.root, candidate.archivePath, "candidate archive", blockers);
  if (!archive) return;
  add(blockers, sha256(archive) === candidate.archiveSha256, "candidate archive SHA-256 does not match the recorded identity");

  const manifest = archiveJson(archive, "manifest.json", "candidate archive", blockers);
  const backendOrigin = exactOrigin(candidate.backendOrigin);
  if (manifest && backendOrigin) {
    add(blockers, manifest.manifest_version === 3, "archive manifest is not Manifest V3");
    add(blockers, manifest.version === candidate.extensionVersion, "archive manifest version does not match candidate extensionVersion");
    add(blockers, Array.isArray(manifest.permissions) && JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]), "archive manifest permissions do not match the candidate contract");
    add(blockers, Array.isArray(manifest.host_permissions) && JSON.stringify(manifest.host_permissions) === JSON.stringify([`${backendOrigin}/*`]), "archive manifest origin does not match candidate backendOrigin");
    add(blockers, manifest.action?.default_popup === "popup.html", "archive manifest popup configuration does not match the candidate contract");
    add(blockers, manifest.background?.service_worker === "service-worker.js" && manifest.background?.type === "module", "archive manifest worker configuration does not match the candidate contract");
    add(blockers, manifest.action?.default_icon?.["16"] === "icons/icon-16.png" && manifest.action?.default_icon?.["48"] === "icons/icon-48.png" && manifest.action?.default_icon?.["128"] === "icons/icon-128.png", "archive manifest icon configuration does not match the candidate contract");
    const csp = String(manifest.content_security_policy?.extension_pages ?? "");
    add(blockers, csp.includes(`connect-src 'self'`) && csp.includes(backendOrigin) && csp.includes(realtimeOrigin(backendOrigin)), "archive manifest CSP does not match candidate backend configuration");
    if (options.expectedOrigin) add(blockers, backendOrigin === exactOrigin(options.expectedOrigin), "candidate backend origin does not match expected release origin");
  }

  if (candidate.networkTracePath && safeEvidenceRef(candidate.networkTracePath)) {
    const tracePath = repositoryFile(options.root, candidate.networkTracePath, "candidate network trace", blockers);
    if (tracePath) {
      add(blockers, sha256(tracePath) === candidate.networkTraceSha256, "candidate network trace SHA-256 does not match the recorded identity");
      try {
        const trace = JSON.parse(readFileSync(tracePath, "utf8"));
        add(blockers, CONTROLLED_ENVIRONMENTS.has(trace.environment), "candidate network trace environment must be release- or production-controlled");
        add(blockers, trace.environment === candidate.environment, "candidate network trace environment does not match candidate environment");
        add(blockers, trace.backendOrigin === backendOrigin, "candidate network trace origin does not match candidate backendOrigin");
        add(blockers, trace.productionEvidence === candidate.productionEvidence, "candidate network trace production flag does not match candidate identity");
      } catch { blockers.push("candidate network trace is invalid JSON"); }
    }
  }

  if (candidate.candidateBuildPath && safeEvidenceRef(candidate.candidateBuildPath)) {
    const metadataPath = repositoryFile(options.root, candidate.candidateBuildPath, "candidate metadata", blockers);
    if (metadataPath) {
      let metadata;
      try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { metadata = null; }
      add(blockers, metadata, "candidate-build.json is invalid");
      if (metadata) {
        add(blockers, metadata.packageVersion === candidate.packageVersion, "candidate package version disagrees with candidate-build.json");
        add(blockers, metadata.sourceCommit === candidate.sourceCommit, "candidate source commit disagrees with candidate-build.json");
        add(blockers, metadata.archiveSha256 === candidate.archiveSha256, "candidate archive digest disagrees with candidate-build.json");
        add(blockers, metadata.networkTraceSha256 === candidate.networkTraceSha256, "candidate network trace digest disagrees with candidate-build.json");
        add(blockers, metadata.backendOrigin === backendOrigin, "candidate backend origin disagrees with candidate-build.json");
        add(blockers, metadata.archive === basename(candidate.archivePath), "candidate archive filename disagrees with candidate-build.json");
        add(blockers, metadata.networkTrace === basename(candidate.networkTracePath), "candidate network trace filename disagrees with candidate-build.json");
      }
    } else blockers.push(`candidate metadata is missing: ${candidate.candidateBuildPath}`);
  }
}

function checkCompatibility(record, blockers) {
  const compatibility = object(record.compatibility);
  add(blockers, compatibility, "compatibility envelope is missing");
  if (!compatibility) return;
  for (const [label, value] of [
    ["snapshot", compatibility.snapshotContracts],
    ["command", compatibility.commandContracts],
  ]) {
    add(blockers, Array.isArray(value) && value.length === 2 && value.every((version) => Number.isInteger(version) && version > 0), `${label} compatibility envelope must list exactly two versions`);
    if (Array.isArray(value) && value.length === 2) add(blockers, value[1] > value[0], `${label} compatibility envelope must be previous then current`);
  }
  add(blockers, string(compatibility.minimumClientVersion) && SEMVER.test(compatibility.minimumClientVersion), "minimum client version is missing or invalid");
  add(blockers, string(compatibility.catalogVersion), "catalog version is missing");
  add(blockers, HEX_40.test(compatibility.catalogSourceCommit ?? ""), "catalog source commit must be a full SHA");
  add(blockers, HEX_64.test(compatibility.catalogSha256 ?? ""), "catalog digest is missing or invalid");
  const art = object(compatibility.art);
  add(blockers, art, "generator/art identity is missing");
  if (art) {
    add(blockers, string(art.generatorRevision), "art generator revision is missing");
    add(blockers, HEX_64.test(art.manifestSha256 ?? ""), "art manifest digest is missing or invalid");
    add(blockers, HEX_64.test(art.checksumsSha256 ?? ""), "art checksum digest is missing or invalid");
    add(blockers, HEX_64.test(art.animationChecksumsSha256 ?? ""), "animation checksum digest is missing or invalid");
  }
}

function checkLocalEvidenceRefs(root, references, label, blockers) {
  add(blockers, Array.isArray(references) && references.length > 0, `${label} evidence must identify at least one reference`);
  if (!Array.isArray(references)) return;
  for (const reference of references) {
    add(blockers, string(reference), `${label} evidence reference must be a non-empty string`);
    if (!string(reference)) continue;
    if (/^https?:\/\//i.test(reference)) blockers.push(`${label} evidence reference must be a verifiable local artifact: ${reference}`);
    else repositoryFile(root, reference, `${label} evidence`, blockers);
  }
}

function checkEvidenceBindings(area, name, root, blockers) {
  if (area.status !== "confirmed") return;
  const bindings = Array.isArray(area.evidenceBindings) ? area.evidenceBindings : null;
  add(blockers, bindings && bindings.length > 0, `${name} confirmed evidence must bind each reference to observed checks`);
  if (!bindings) return;
  const referenced = new Set(area.evidenceRefs);
  const observed = new Set();
  for (const binding of bindings) {
    add(blockers, object(binding), `${name} evidence binding is invalid`);
    if (!object(binding)) continue;
    add(blockers, referenced.has(binding.ref), `${name} evidence binding references an unlisted artifact`);
    add(blockers, HEX_64.test(binding.sha256 ?? ""), `${name} evidence binding digest is invalid`);
    const file = repositoryFile(root, binding.ref, `${name} evidence binding`, blockers);
    if (file) add(blockers, sha256(file) === binding.sha256, `${name} evidence binding digest does not match: ${binding.ref}`);
    add(blockers, Array.isArray(binding.checks) && binding.checks.length > 0, `${name} evidence binding must list observed checks`);
    if (Array.isArray(binding.checks)) for (const check of binding.checks) {
      add(blockers, string(check), `${name} evidence binding check names must be strings`);
      if (string(check)) observed.add(check);
    }
  }
  const checks = object(area.checks);
  if (checks) for (const check of Object.keys(checks)) add(blockers, observed.has(check), `${name} check is not bound to observed evidence: ${check}`);
}

function checkEvidenceArea(area, name, root, blockers) {
  add(blockers, area, `${name} evidence is missing`);
  if (!area) return;
  add(blockers, STATUS_VALUES.has(area.status), `${name} evidence status is invalid`);
  add(blockers, ["production-controlled", "release-controlled", "local-controlled", "not-provided"].includes(area.environment), `${name} evidence environment is not explicit`);
  checkLocalEvidenceRefs(root, area.evidenceRefs, name, blockers);
  checkEvidenceBindings(area, name, root, blockers);
  if (area.status === "confirmed") {
    add(blockers, ["production-controlled", "release-controlled"].includes(area.environment), `${name} confirmed evidence must be production- or release-controlled`);
    add(blockers, area.productionEvidence === true, `${name} confirmed evidence must carry positive production evidence`);
    add(blockers, isoDate(area.observedAt), `${name} confirmed evidence must have an observation date`);
    const checks = object(area.checks);
    add(blockers, checks && Object.keys(checks).length > 0, `${name} confirmed evidence must enumerate checks`);
    if (checks) for (const [check, value] of Object.entries(checks)) {
      add(blockers, typeof value === "boolean", `${name} evidence check must be boolean: ${check}`);
      add(blockers, value === true, `${name} evidence check is incomplete: ${check}`);
    }
    add(blockers, area.credentialDisclosure === "none", `${name} evidence must state that credentials are not recorded`);
  }
  if (area.status === "blocked" || area.status === "pending" || area.status === "not-provided") {
    add(blockers, area.productionEvidence !== true, `${name} cannot claim production evidence while incomplete`);
  }
}

function checkPrimarySources(record, options, blockers) {
  const rows = Array.isArray(record.primarySourceRechecks) ? record.primarySourceRechecks : null;
  add(blockers, rows, "primary-source recheck list is missing");
  if (!rows) return;
  const authorities = new Set();
  for (const [index, row] of rows.entries()) {
    const path = `primary-source recheck ${index + 1}`;
    add(blockers, object(row), `${path} is invalid`);
    if (!object(row)) continue;
    authorities.add(row.authority);
    add(blockers, REQUIRED_PRIMARY_SOURCE_AUTHORITIES.includes(row.authority), `${path} has an unsupported authority`);
    add(blockers, httpsUrl(row.url), `${path} must cite an HTTPS primary source URL`);
    if (REQUIRED_PRIMARY_SOURCE_AUTHORITIES.includes(row.authority)) add(blockers, firstPartySourceUrl(row.authority, row.url), `${path} URL is not an allowlisted first-party source for ${row.authority}`);
    add(blockers, row.sourceType === "primary", `${path} is not marked as a primary source`);
    add(blockers, isoDate(row.checkedAt), `${path} is missing a valid checkedAt timestamp`);
    add(blockers, string(row.constraint), `${path} does not state the rechecked constraint`);
    add(blockers, ["confirmed", "changed", "not-rechecked", "unavailable"].includes(row.result), `${path} result is invalid`);
    if (row.result !== "confirmed") blockers.push(`${path} was not positively rechecked; current constraints are not established`);
    if (isoDate(row.checkedAt) && options.now) {
      const age = options.now.getTime() - Date.parse(row.checkedAt);
      add(blockers, age >= 0, `${path} is dated in the future`);
      add(blockers, age <= (options.primarySourceMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000), `${path} is stale for release qualification`);
    }
  }
  for (const authority of REQUIRED_PRIMARY_SOURCE_AUTHORITIES) add(blockers, authorities.has(authority), `primary-source recheck is missing authority: ${authority}`);
}

export function findEarliestBlockedGate(gates) {
  if (!Array.isArray(gates)) return 0;
  const first = gates.find((gate) => !object(gate) || gate.status !== "passed");
  return first ? Number.isInteger(first.id) ? first.id : 0 : null;
}

function checkGateBindings(gate, root, blockers) {
  if (gate.status !== "passed") return;
  add(blockers, Array.isArray(gate.observedChecks) && gate.observedChecks.length > 0, `Gate ${gate.id} passed without observed checks`);
  const bindings = Array.isArray(gate.evidenceBindings) ? gate.evidenceBindings : null;
  add(blockers, bindings && bindings.length > 0, `Gate ${gate.id} passed without bound evidence`);
  if (!bindings) return;
  const referenced = new Set(gate.evidenceRefs);
  const observed = new Set();
  for (const binding of bindings) {
    add(blockers, object(binding), `Gate ${gate.id} evidence binding is invalid`);
    if (!object(binding)) continue;
    add(blockers, referenced.has(binding.ref), `Gate ${gate.id} evidence binding references an unlisted artifact`);
    add(blockers, HEX_64.test(binding.sha256 ?? ""), `Gate ${gate.id} evidence binding digest is invalid`);
    const file = repositoryFile(root, binding.ref, `Gate ${gate.id} evidence binding`, blockers);
    if (file) add(blockers, sha256(file) === binding.sha256, `Gate ${gate.id} evidence binding digest does not match: ${binding.ref}`);
    add(blockers, Array.isArray(binding.checks) && binding.checks.length > 0, `Gate ${gate.id} evidence binding must list observed checks`);
    if (Array.isArray(binding.checks)) for (const check of binding.checks) {
      add(blockers, string(check), `Gate ${gate.id} evidence binding check names must be strings`);
      if (string(check)) observed.add(check);
    }
  }
  for (const check of gate.observedChecks ?? []) {
    add(blockers, string(check), `Gate ${gate.id} observed check names must be strings`);
    if (string(check)) add(blockers, observed.has(check), `Gate ${gate.id} observed check is not bound to evidence: ${check}`);
  }
}

function checkGates(record, root, blockers) {
  const gates = Array.isArray(record.gates) ? record.gates : null;
  add(blockers, gates && gates.length === GATE_DEFINITIONS.length, "qualification must record Gates 0 through 6");
  if (!gates) return null;
  const ids = gates.map((gate) => gate?.id);
  add(blockers, ids.every((id, index) => id === index), "qualification gates must be ordered 0 through 6");
  for (const definition of GATE_DEFINITIONS) {
    const gate = gates[definition.id];
    add(blockers, gate?.name === definition.name, `Gate ${definition.id} name does not match the cumulative gate definition`);
    add(blockers, ["passed", "blocked", "pending", "reopened"].includes(gate?.status), `Gate ${definition.id} status is invalid`);
    add(blockers, typeof gate?.codeComplete === "boolean", `Gate ${definition.id} must distinguish code-complete checks`);
    checkLocalEvidenceRefs(root, gate?.evidenceRefs, `Gate ${definition.id}`, blockers);
    if (gate) checkGateBindings(gate, root, blockers);
  }
  const earliest = findEarliestBlockedGate(gates);
  if (earliest !== null) {
    for (const gate of gates) {
      if (gate.id > earliest && ["passed", "pending"].includes(gate.status)) blockers.push(`Gate ${gate.id} is ${gate.status} after Gate ${earliest} failed; cumulative gates must be blocked or reopened`);
    }
  }
  return earliest;
}

function checkPublisherAndRisk(record, root, blockers) {
  const publisher = object(record.publisherControls);
  add(blockers, publisher, "publisher controls are missing");
  if (publisher) {
    for (const name of ["developerAccount", "verifiedContactEmail", "twoStepVerification", "privacyUrl", "supportRoute"]) {
      const control = object(publisher[name]);
      add(blockers, control, `publisher control is missing: ${name}`);
      if (control) {
        add(blockers, STATUS_VALUES.has(control.status), `publisher control status is invalid: ${name}`);
        if (control.status !== "confirmed") blockers.push(`publisher control is not confirmed: ${name}`);
        if (control.status === "confirmed") {
          add(blockers, isoDate(control.confirmedAt), `publisher control confirmation is undated: ${name}`);
          add(blockers, string(control.evidenceRef) && safeEvidenceRef(control.evidenceRef), `publisher control evidence is missing: ${name}`);
          add(blockers, HEX_64.test(control.evidenceSha256 ?? ""), `publisher control evidence digest is missing: ${name}`);
          const file = repositoryFile(root, control.evidenceRef, `publisher control ${name}`, blockers);
          if (file) add(blockers, sha256(file) === control.evidenceSha256, `publisher control evidence digest does not match: ${name}`);
        }
      }
    }
  }
  const risk = object(record.ownerResidualRisk);
  add(blockers, risk, "owner residual-risk record is missing");
  if (risk) {
    add(blockers, risk.status === "accepted" || risk.status === "pending", "owner residual-risk status is invalid");
    add(blockers, risk.accepted === true, "owner residual catalog/brand risk is not accepted for this exact candidate");
    if (risk.accepted === true) {
      add(blockers, string(risk.acceptedBy), "owner residual-risk acceptance lacks an owner");
      add(blockers, isoDate(risk.acceptedAt), "owner residual-risk acceptance lacks a date");
      add(blockers, risk.legalAdvice === false, "residual-risk record must not claim legal advice");
      add(blockers, risk.rightsHolderAuthorizationClaimed === false, "residual-risk record must not claim rights-holder authorization");
    }
    add(blockers, string(risk.scope), "residual-risk scope is missing");
  }
}

export function auditQualificationRecord(input, options = {}) {
  const record = object(input);
  const blockers = [];
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const auditOptions = { ...options, now };
  add(blockers, record, "qualification record is not an object");
  if (!record) return { eligible: false, blockers, earliestBlockedGate: 0, record: null };
  checkAllowedKeys(record, "record", blockers);
  checkNoSecrets(record, "record", blockers);
  checkFreeFormText(record, blockers);
  add(blockers, record.schemaVersion === QUALIFICATION_SCHEMA_VERSION, "qualification record schema version is unsupported");
  add(blockers, string(record.recordId), "qualification record ID is missing");
  add(blockers, isoDate(record.recordedAt), "qualification record date is missing or invalid");
  add(blockers, ["blocked", "pending", "qualified"].includes(record.status), "qualification record status is invalid");
  add(blockers, record.releaseEligible === false || record.releaseEligible === true, "qualification record releaseEligible must be explicit");
  add(blockers, record.submissionPerformed === false && record.submissionStatus === "not-performed", "qualification must not submit to Chrome Web Store");
  add(blockers, Array.isArray(record.notes) && record.notes.every(string), "qualification notes must be non-sensitive strings");
  checkCandidate(record, auditOptions, blockers);
  checkCompatibility(record, blockers);
  const evidence = object(record.evidence);
  add(blockers, evidence, "release evidence map is missing");
  if (evidence) for (const area of REQUIRED_EVIDENCE_AREAS) checkEvidenceArea(evidence[area], area, options.root, blockers);
  checkPrimarySources(record, auditOptions, blockers);
  const earliestFromGates = checkGates(record, options.root, blockers);
  checkPublisherAndRisk(record, options.root, blockers);

  const declaredBlockers = Array.isArray(record.externalBlockers) ? record.externalBlockers : null;
  add(blockers, declaredBlockers && declaredBlockers.every((entry) => string(entry)), "external blockers must be explicit strings");
  if (declaredBlockers && record.status !== "qualified") blockers.push(...declaredBlockers.map((entry) => `external blocker: ${entry}`));
  add(blockers, record.status === "qualified" ? record.releaseEligible === true : true, "a qualified record must set releaseEligible=true");
  if (record.status === "qualified" && blockers.length > 0) blockers.push("record claims qualification while one or more checks are blocked");
  if (record.status !== "qualified" && record.releaseEligible === true) blockers.push("blocked/pending record cannot be release eligible");

  const uniqueBlockers = [...new Set(blockers)];
  const earliest = earliestFromGates ?? (uniqueBlockers.length ? 0 : null);
  return {
    eligible: uniqueBlockers.length === 0 && record.status === "qualified" && record.releaseEligible === true,
    blockers: uniqueBlockers,
    earliestBlockedGate: earliest,
    record,
  };
}

export function validateQualificationRecord(input, options = {}) {
  const result = auditQualificationRecord(input, options);
  if (!result.eligible) {
    const error = new Error(`Release qualification blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
    error.blockers = result.blockers;
    error.earliestBlockedGate = result.earliestBlockedGate;
    throw error;
  }
  return result;
}

export function readQualificationRecord(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("record path must be a regular non-symlink file");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  catch (error) { throw new Error(`qualification record is missing or invalid: ${error.message}`); }
}

export function qualificationRecordPath(root) {
  return join(root, "artifacts/ticket41-qualification/release-qualification.json");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const path = resolve(process.env.RELEASE_QUALIFICATION_RECORD ?? qualificationRecordPath(root));
  let record;
  try { record = readQualificationRecord(path); }
  catch (error) {
    console.error(`Release qualification blocked:\n- ${error.message}`);
    process.exitCode = 1;
  }
  if (record) {
    const result = auditQualificationRecord(record, { root });
    if (!result.eligible) {
      console.error(`Release qualification blocked (earliest Gate ${result.earliestBlockedGate ?? "unknown"}):`);
      for (const blocker of result.blockers) console.error(`- ${blocker}`);
      process.exitCode = 1;
    } else console.log("Release qualification OK: all cumulative gates and external controls are evidenced.");
  }
}
