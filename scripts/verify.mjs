import { execFileSync } from "node:child_process";

const run = (script) => execFileSync("pnpm", [script], { stdio: "inherit" });

run("backend:start");
try {
  // The local Supabase project is a disposable verification sandbox. Reset it
  // so repeated verification runs cannot inherit fixture rows or a stale
  // singleton recovery state; this never targets a managed production DB.
  run("backend:reset");
  // Run before integration tests create fixture rows. The report is local
  // simulation evidence, not provider confirmation for Gate 4.
  run("recovery:rehearse");
  run("check");
  run("smoke");
} finally {
  run("backend:stop");
}
