import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePublicationPackage } from "./check-publication-package.mjs";
import { createDeterministicZip } from "./deterministic-zip.mjs";
import { validateNetworkTrace } from "./network-trace.mjs";
import { validatePublishableKey } from "./publishable-key.mjs";
import { exactOrigin, releaseOrigin } from "./release-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const output = resolve(process.env.PUBLICATION_OUTPUT_DIR ?? join(root, "artifacts/ticket40-publication"));
const mode = process.env.PUBLICATION_MODE ?? "draft";
if (!["draft", "release"].includes(mode)) throw new Error("PUBLICATION_MODE must be draft or release.");
const suppliedOrigin = process.env.PUBLICATION_BACKEND_ORIGIN ?? process.env.SUPABASE_URL;
if (!suppliedOrigin) throw new Error("PUBLICATION_BACKEND_ORIGIN or SUPABASE_URL is required for a candidate build.");
const origin = mode === "release" ? releaseOrigin(suppliedOrigin) : exactOrigin(suppliedOrigin);
if (!origin) throw new Error("publication backend origin must be an exact HTTP(S) origin without a path");
const key = process.env.PUBLICATION_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
if (!key) throw new Error("PUBLICATION_ANON_KEY or SUPABASE_ANON_KEY is required; no development credential is implicit.");
if (mode === "release") validatePublishableKey(key);

const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const traceSource = join(root, "docs/release/network-trace-controlled.json");
if (!existsSync(traceSource)) throw new Error("controlled network trace evidence is required before assembling a candidate");
const trace = JSON.parse(readFileSync(traceSource, "utf8"));
validateNetworkTrace(trace, { expectedOrigin: origin, release: mode === "release" });

const parent = dirname(output);
mkdirSync(parent, { recursive: true });
const staging = resolve(parent, `.ticket40-publication-${process.pid}-${Date.now()}`);
mkdirSync(staging, { recursive: true });
const archive = join(staging, `larp-code-${packageVersion}.zip`);

function replaceOutputDirectory(next) {
  const previous = `${output}.previous`;
  let movedPrevious = false;
  try {
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true });
    if (existsSync(output)) {
      renameSync(output, previous);
      movedPrevious = true;
    }
    renameSync(next, output);
    if (movedPrevious) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious && !existsSync(output) && existsSync(previous)) renameSync(previous, output);
    throw error;
  }
}

try {
  const environment = {
    ...process.env,
    SUPABASE_URL: origin,
    SUPABASE_ANON_KEY: key,
  };
  execFileSync("pnpm", ["build"], { cwd: root, env: environment, stdio: "inherit" });
  await validatePublicationPackage(dist, { expectedOrigin: origin, allowLocal: mode === "draft" });
  createDeterministicZip(dist, archive);
  await validatePublicationPackage(archive, { expectedOrigin: origin, allowLocal: mode === "draft" });
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const traceCopy = join(staging, "network-trace.json");
  writeFileSync(traceCopy, `${JSON.stringify(trace, null, 2)}\n`);
  writeFileSync(join(staging, "candidate.sha256"), `${digest}  ${archive.split("/").pop()}\n`);
  writeFileSync(join(staging, "candidate-build.json"), `${JSON.stringify({
    packageVersion,
    sourceCommit,
    backendOrigin: origin,
    archive: archive.split("/").pop(),
    archiveSha256: digest,
    networkTrace: "network-trace.json",
    networkTraceSha256: createHash("sha256").update(readFileSync(traceCopy)).digest("hex"),
    generatedAt: new Date().toISOString(),
    qualification: mode,
    releaseEligible: mode === "release",
    humanReview: mode === "release" ? "attested" : "pending",
  }, null, 2)}\n`);

  replaceOutputDirectory(staging);
  console.log(`Candidate package assembled: ${join(output, archive.split("/").pop())}`);
  console.log(`Candidate SHA-256: ${digest}`);
} catch (error) {
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  throw error;
}
