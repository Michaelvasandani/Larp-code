import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
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

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value) {
  return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
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
  if (/^[a-z]+:\/\//i.test(value)) return httpsUrl(value);
  if (isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").includes("..") && !normalized.startsWith("/");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function add(blockers, condition, message) {
  if (!condition) blockers.push(message);
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
      /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
    ];
    if (prohibited.some((pattern) => pattern.test(value))) blockers.push(`${path} contains credential-like material`);
    return blockers;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => checkNoSecrets(entry, `${path}[${index}]`, blockers));
    return blockers;
  }
  if (object(value)) {
    Object.entries(value).forEach(([key, entry]) => checkNoSecrets(entry, `${path}.${key}`, blockers));
  }
  return blockers;
}

function checkCandidate(record, options, blockers) {
  const candidate = object(record.candidate);
  add(blockers, candidate, "candidate identity is missing");
  if (!candidate) return;
  add(blockers, string(candidate.packageVersion) && SEMVER.test(candidate.packageVersion), "candidate package version is invalid");
  add(blockers, string(candidate.extensionVersion) && SEMVER.test(candidate.extensionVersion), "candidate extension version is invalid");
  add(blockers, HEX_40.test(candidate.sourceCommit ?? ""), "candidate source commit must be a full 40-character SHA");
  add(blockers, HEX_64.test(candidate.archiveSha256 ?? ""), "candidate archive SHA-256 must be a full 64-character digest");
  add(blockers, string(candidate.archivePath) && safeEvidenceRef(candidate.archivePath), "candidate archive path is missing or unsafe");
  add(blockers, string(candidate.candidateBuildPath) && safeEvidenceRef(candidate.candidateBuildPath), "candidate metadata path is missing or unsafe");
  add(blockers, exactOrigin(candidate.backendOrigin), "candidate backend origin must be an exact HTTP(S) origin");
  add(blockers, ["local-controlled", "release-controlled", "production-controlled"].includes(candidate.environment), "candidate environment is not explicit");
  add(blockers, candidate.productionEvidence === true, "candidate lacks positive production-controlled evidence");
  if (candidate.environment === "production-controlled") add(blockers, !isReservedOrigin(candidate.backendOrigin), "production candidate backend origin is reserved or not public");
  add(blockers, HEX_64.test(candidate.networkTraceSha256 ?? ""), "candidate network trace SHA-256 is missing or invalid");
  add(blockers, string(candidate.networkTracePath) && safeEvidenceRef(candidate.networkTracePath), "candidate network trace path is missing or unsafe");

  if (!candidate.archivePath || !options.root || !safeEvidenceRef(candidate.archivePath)) return;
  const archive = resolve(options.root, candidate.archivePath);
  const root = resolve(options.root);
  add(blockers, archive === root || archive.startsWith(`${root}${sep}`), "candidate archive path escapes the repository");
  if (!existsSync(archive)) {
    blockers.push(`candidate archive is missing: ${candidate.archivePath}`);
    return;
  }
  add(blockers, sha256(archive) === candidate.archiveSha256, "candidate archive SHA-256 does not match the recorded identity");

  if (candidate.networkTracePath && safeEvidenceRef(candidate.networkTracePath)) {
    const tracePath = resolve(options.root, candidate.networkTracePath);
    if (existsSync(tracePath)) add(blockers, sha256(tracePath) === candidate.networkTraceSha256, "candidate network trace SHA-256 does not match the recorded identity");
    else blockers.push(`candidate network trace is missing: ${candidate.networkTracePath}`);
  }

  if (candidate.candidateBuildPath && safeEvidenceRef(candidate.candidateBuildPath)) {
    const metadataPath = resolve(options.root, candidate.candidateBuildPath);
    if (existsSync(metadataPath)) {
      let metadata;
      try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { metadata = null; }
      add(blockers, metadata, "candidate-build.json is invalid");
      if (metadata) {
        add(blockers, metadata.packageVersion === candidate.packageVersion, "candidate package version disagrees with candidate-build.json");
        add(blockers, metadata.sourceCommit === candidate.sourceCommit, "candidate source commit disagrees with candidate-build.json");
        add(blockers, metadata.archiveSha256 === candidate.archiveSha256, "candidate archive digest disagrees with candidate-build.json");
        add(blockers, metadata.networkTraceSha256 === candidate.networkTraceSha256, "candidate network trace digest disagrees with candidate-build.json");
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

function checkEvidenceArea(area, name, blockers) {
  add(blockers, area, `${name} evidence is missing`);
  if (!area) return;
  add(blockers, STATUS_VALUES.has(area.status), `${name} evidence status is invalid`);
  add(blockers, ["production-controlled", "release-controlled", "local-controlled", "not-provided"].includes(area.environment), `${name} evidence environment is not explicit`);
  add(blockers, Array.isArray(area.evidenceRefs) && area.evidenceRefs.length > 0 && area.evidenceRefs.every(safeEvidenceRef), `${name} evidence must identify a safe evidence reference`);
  if (area.status === "confirmed") {
    add(blockers, ["production-controlled", "release-controlled"].includes(area.environment), `${name} confirmed evidence must be production- or release-controlled`);
    add(blockers, area.productionEvidence === true, `${name} confirmed evidence must carry positive production evidence`);
    add(blockers, isoDate(area.observedAt), `${name} confirmed evidence must have an observation date`);
    const checks = object(area.checks);
    add(blockers, checks && Object.keys(checks).length > 0, `${name} confirmed evidence must enumerate checks`);
    if (checks) for (const [check, value] of Object.entries(checks)) add(blockers, value === true, `${name} evidence check is incomplete: ${check}`);
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

function checkGates(record, blockers) {
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
    add(blockers, Array.isArray(gate?.evidenceRefs) && gate.evidenceRefs.every(safeEvidenceRef), `Gate ${definition.id} evidence references are invalid`);
  }
  const earliest = findEarliestBlockedGate(gates);
  if (earliest !== null) {
    for (const gate of gates) {
      if (gate.id > earliest && gate.status === "passed") blockers.push(`Gate ${gate.id} is marked passed after Gate ${earliest} failed; cumulative gates must reopen`);
    }
  }
  return earliest;
}

function checkPublisherAndRisk(record, blockers) {
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
  checkNoSecrets(record, "record", blockers);
  add(blockers, record.schemaVersion === QUALIFICATION_SCHEMA_VERSION, "qualification record schema version is unsupported");
  add(blockers, string(record.recordId), "qualification record ID is missing");
  add(blockers, isoDate(record.recordedAt), "qualification record date is missing or invalid");
  add(blockers, ["blocked", "pending", "qualified"].includes(record.status), "qualification record status is invalid");
  add(blockers, record.releaseEligible === false || record.releaseEligible === true, "qualification record releaseEligible must be explicit");
  add(blockers, record.submissionPerformed === false && record.submissionStatus === "not-performed", "qualification must not submit to Chrome Web Store");
  checkCandidate(record, auditOptions, blockers);
  checkCompatibility(record, blockers);
  const evidence = object(record.evidence);
  add(blockers, evidence, "release evidence map is missing");
  if (evidence) for (const area of REQUIRED_EVIDENCE_AREAS) checkEvidenceArea(evidence[area], area, blockers);
  checkPrimarySources(record, auditOptions, blockers);
  const earliestFromGates = checkGates(record, blockers);
  checkPublisherAndRisk(record, blockers);

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
  try { return JSON.parse(readFileSync(path, "utf8")); }
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
