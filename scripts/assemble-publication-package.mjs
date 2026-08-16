import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePublicationPackage } from "./check-publication-package.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const output = resolve(process.env.PUBLICATION_OUTPUT_DIR ?? join(root, "artifacts/ticket40-publication"));
const origin = process.env.PUBLICATION_BACKEND_ORIGIN ?? process.env.SUPABASE_URL;
if (!origin) throw new Error("PUBLICATION_BACKEND_ORIGIN or SUPABASE_URL is required for a candidate build.");
if (!process.env.PUBLICATION_ANON_KEY && !process.env.SUPABASE_ANON_KEY) {
  throw new Error("PUBLICATION_ANON_KEY or SUPABASE_ANON_KEY is required; no development credential is implicit.");
}

mkdirSync(output, { recursive: true });
const environment = {
  ...process.env,
  SUPABASE_URL: origin,
  SUPABASE_ANON_KEY: process.env.PUBLICATION_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
};
execFileSync("pnpm", ["build"], { cwd: root, env: environment, stdio: "inherit" });
await validatePublicationPackage(dist, { expectedOrigin: origin });

const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const archive = join(output, `larp-code-${packageVersion}.zip`);
execFileSync("zip", ["-q", "-X", "-r", archive, "."], { cwd: dist, stdio: "inherit" });
await validatePublicationPackage(archive, { expectedOrigin: origin });
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(join(output, "candidate.sha256"), `${digest}  ${archive.split("/").pop()}\n`);
writeFileSync(join(output, "candidate-build.json"), `${JSON.stringify({
  packageVersion,
  sourceCommit,
  backendOrigin: new URL(origin).origin,
  archive: archive.split("/").pop(),
  archiveSha256: digest,
  generatedAt: new Date().toISOString(),
  humanReview: "pending",
}, null, 2)}\n`);
console.log(`Candidate package assembled: ${archive}`);
console.log(`Candidate SHA-256: ${digest}`);
