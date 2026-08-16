import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [action, outputArg] = process.argv.slice(2);
const output = resolve(outputArg ?? process.env.REVIEW_FIXTURE_OUTPUT ?? "");
if (!action || !["setup", "teardown"].includes(action) || !outputArg && !process.env.REVIEW_FIXTURE_OUTPUT) {
  throw new Error("usage: reviewer-fixture.mjs <setup|teardown> <disposable-json-path>");
}
if (!output.endsWith(".json") || output === resolve("/") || output.includes("..")) throw new Error("fixture path must be a direct JSON file path");

if (action === "setup") {
  const base = new Date(process.env.REVIEW_FIXTURE_NOW ?? "2026-08-16T00:00:00.000Z");
  if (Number.isNaN(base.valueOf())) throw new Error("REVIEW_FIXTURE_NOW must be an ISO date");
  const date = (days) => new Date(base.valueOf() + days * 86_400_000).toISOString();
  const fixture = {
    version: 1,
    fixtureId: "larp-code-review-fixture-v1",
    mode: "descriptor-only",
    credentials: "none",
    accounts: ["reviewer-account-a", "reviewer-account-b"],
    dates: { scheduled: date(2), active: date(4), deadline: date(11), terminal: date(12) },
    states: ["Scheduled", "Active", "Active-behind", "Terminal"],
    teardownRequired: true,
    note: "Provision these states only in a disposable controlled release environment; this descriptor creates no account or backend row.",
  };
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(fixture, null, 2)}\n`);
  renameSync(temporary, output);
  console.log(`Reviewer fixture descriptor created: ${output}`);
} else {
  if (!existsSync(output)) throw new Error(`reviewer fixture does not exist: ${output}`);
  const fixture = JSON.parse(readFileSync(output, "utf8"));
  if (fixture.fixtureId !== "larp-code-review-fixture-v1" || fixture.credentials !== "none") throw new Error("unexpected reviewer fixture descriptor");
  rmSync(output, { force: true });
  console.log(`Reviewer fixture descriptor removed: ${output}`);
}
