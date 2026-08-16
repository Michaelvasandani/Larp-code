import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { validatePublicationPackage } from "./check-publication-package.mjs";
import { validateNetworkTrace } from "./network-trace.mjs";
import { validatePublishableKey } from "./publishable-key.mjs";
import { releaseOrigin } from "./release-contract.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(process.env.PUBLICATION_OUTPUT_DIR ?? join(root, "artifacts/ticket40-publication"));
const metadataPath = join(output, "candidate-build.json");
const archiveShaPath = join(output, "candidate.sha256");
const attestationPath = join(root, "docs/release/gate5-attestation.json");
const blockers = [];
const add = (condition, message) => { if (!condition) blockers.push(message); };

let metadata;
try { metadata = JSON.parse(readFileSync(metadataPath, "utf8")); } catch { blockers.push("candidate-build.json is missing or invalid"); }
let origin;
try { origin = releaseOrigin(process.env.PUBLICATION_BACKEND_ORIGIN ?? process.env.SUPABASE_URL); } catch (error) { blockers.push(error.message); }
try { validatePublishableKey(process.env.PUBLICATION_ANON_KEY ?? process.env.SUPABASE_ANON_KEY); } catch (error) { blockers.push(`publishable key: ${error.message}`); }

const archive = metadata?.archive ? join(output, metadata.archive) : null;
add(Boolean(archive && existsSync(archive)), "candidate archive is missing");
if (metadata) {
  add(metadata.qualification === "release" && metadata.releaseEligible === true, "candidate is draft/non-qualifying; assemble with PUBLICATION_MODE=release");
  add(!origin || metadata.backendOrigin === origin, "candidate backend origin does not match the real release origin");
  if (archive && existsSync(archive)) {
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    add(digest === metadata.archiveSha256, "candidate archive SHA-256 does not match candidate-build.json");
    add(readFileSync(archiveShaPath, "utf8").startsWith(`${digest}  `), "candidate.sha256 does not match the archive");
    try { await validatePublicationPackage(archive, { expectedOrigin: origin, release: true }); } catch (error) { blockers.push(error.message); }
  }
  const tracePath = metadata.networkTrace ? join(output, metadata.networkTrace) : null;
  try {
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    validateNetworkTrace(trace, { expectedOrigin: origin, release: true });
    add(createHash("sha256").update(readFileSync(tracePath)).digest("hex") === metadata.networkTraceSha256, "network trace digest does not match candidate metadata");
  } catch (error) { blockers.push(`network trace: ${error.message}`); }
}

try {
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  add(attestation.status === "approved" && attestation.attested === true, "Gate 5 human attestation is not approved and signed");
  add(typeof attestation.signedBy === "string" && attestation.signedBy.length > 0, "Gate 5 attestation lacks a signer");
  add(typeof attestation.signedAt === "string" && !Number.isNaN(Date.parse(attestation.signedAt)), "Gate 5 attestation lacks a valid signed date");
  for (const [name, value] of Object.entries(attestation.checks ?? {})) add(value === true, `Gate 5 attestation check is incomplete: ${name}`);
  for (const name of ["publicPrivacyUrl", "supportMonitoring", "rights", "visualAndDisclosureReview", "reviewerOutcome"]) add(attestation.checks?.[name] === true, `Gate 5 attestation check is missing: ${name}`);
} catch { blockers.push("Gate 5 signed/dated attestation artifact is missing or invalid"); }

if (blockers.length) {
  console.error("Release qualification blocked:");
  for (const blocker of [...new Set(blockers)]) console.error(`- ${blocker}`);
  process.exitCode = 1;
} else {
  console.log("Release qualification OK: production inputs, archive, trace, and Gate 5 attestation are complete.");
}
