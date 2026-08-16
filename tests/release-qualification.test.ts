import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditQualificationRecord,
  findEarliestBlockedGate,
  validateQualificationRecord,
} from "../scripts/release-qualification.mjs";

const root = resolve(process.cwd());

function pendingRecord() {
  return JSON.parse(readFileSync(resolve(root, "artifacts/ticket41-qualification/release-qualification.json"), "utf8"));
}

describe("Ticket 41 release qualification", () => {
  it("fails closed for the checked-in record and enumerates external blockers", () => {
    const result = auditQualificationRecord(pendingRecord(), { root });

    expect(result.eligible).toBe(false);
    expect(result.earliestBlockedGate).toBe(5);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("production Supabase"),
      expect.stringContaining("Resend"),
      expect.stringContaining("two-account end-to-end"),
      expect.stringContaining("publisher"),
      expect.stringContaining("residual"),
    ]));
    expect(pendingRecord().primarySourceRechecks.every((row: { result: string }) => row.result === "confirmed")).toBe(true);
  });

  it("reopens every later gate after the first failed gate", () => {
    const record = pendingRecord();
    record.gates[2].status = "blocked";
    record.gates[3].status = "passed";
    record.gates[4].status = "passed";
    record.gates[5].status = "passed";
    record.gates[6].status = "passed";

    expect(findEarliestBlockedGate(record.gates)).toBe(2);
    const result = auditQualificationRecord(record, { root });
    expect(result.earliestBlockedGate).toBe(2);
    expect(result.blockers).toContain("Gate 3 is marked passed after Gate 2 failed; cumulative gates must reopen");
  });

  it("throws a useful aggregate error when strict validation is requested", () => {
    expect(() => validateQualificationRecord(pendingRecord(), { root })).toThrow(/Release qualification blocked/);
  });
});
