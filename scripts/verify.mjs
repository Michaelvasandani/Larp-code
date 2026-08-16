import { execFileSync } from "node:child_process";

const run = (script) => execFileSync("pnpm", [script], { stdio: "inherit" });

run("backend:start");
try {
  // Run against the freshly started isolated database before the parallel
  // integration tests create their fixture rows. The report is the durable
  // Gate 4 evidence; ordinary tests must not race the singleton write gate.
  run("recovery:rehearse");
  run("check");
  run("smoke");
} finally {
  run("backend:stop");
}
