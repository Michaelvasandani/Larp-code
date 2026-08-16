import { execFileSync } from "node:child_process";

const run = (script) => execFileSync("pnpm", [script], { stdio: "inherit" });

run("backend:start");
try {
  run("check");
  run("smoke");
} finally {
  run("backend:stop");
}
