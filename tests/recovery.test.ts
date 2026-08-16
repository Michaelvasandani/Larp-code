import { describe, expect, it } from "vitest";

import {
  DURABILITY_BEHAVIOR,
  REQUIRED_RECOVERY_CHECKS,
  createRecoveryReport,
  isSafeRecoveryReportPayload,
  selectLatestSafeRecoveryPoint,
  validateRecoveryEvidence,
} from "../src/shared/recovery";

describe("managed recovery contract", () => {
  it("selects the latest restore point strictly before the fault and inside the PITR window", () => {
    const faultAt = "2026-08-16T12:00:00.000Z";
    expect(selectLatestSafeRecoveryPoint({
      faultAt,
      candidates: [
        "2026-08-08T12:00:00.000Z",
        "2026-08-16T11:45:00.000Z",
        "2026-08-16T11:59:59.000Z",
        faultAt,
        "2026-08-16T12:05:00.000Z",
      ],
    })).toBe("2026-08-16T11:59:59.000Z");
  });

  it("rejects a fault with no safe point in the managed seven-day window", () => {
    expect(() => selectLatestSafeRecoveryPoint({
      faultAt: "2026-08-16T12:00:00.000Z",
      candidates: ["2026-08-08T12:00:00.000Z", "2026-08-16T12:00:00.000Z"],
    })).toThrow(/safe recovery point/i);
  });

  it("requires every Gate 4 restore check before reopening", () => {
    const incomplete = Object.fromEntries(REQUIRED_RECOVERY_CHECKS.map((check) => [check, true]));
    incomplete.mailIntegration = false;
    expect(validateRecoveryEvidence(incomplete)).toMatchObject({ readyToReopen: false, failedChecks: ["mailIntegration"] });
    expect(validateRecoveryEvidence({ ...incomplete, mailIntegration: true })).toMatchObject({ readyToReopen: true, failedChecks: [] });
  });

  it("records measured ordinary and catastrophic durability without an absolute guarantee", () => {
    expect(DURABILITY_BEHAVIOR.ordinaryInterruption).toMatch(/exactly once/i);
    expect(DURABILITY_BEHAVIOR.catastrophicRestore).toMatch(/acknowledged transactions/i);
    const report = createRecoveryReport({
      incident: "local-rehearsal",
      scenario: "destructive-incident",
      selectedRestorePoint: "2026-08-16T11:59:59.000Z",
      faultAt: "2026-08-16T12:00:00.000Z",
      validation: validateRecoveryEvidence(Object.fromEntries(REQUIRED_RECOVERY_CHECKS.map((check) => [check, true]))),
      measured: { freezeMilliseconds: 14, restoreMilliseconds: 21, retryOutcome: "replayed_by_same_key" },
      failures: [],
      correctiveActions: ["Repeat the exercise after each provider configuration change."],
    });
    expect(report.memberDataIncluded).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/email|token|snapshot|solve|pet|secret/i);
    expect(report.durability).toEqual(DURABILITY_BEHAVIOR);
  });

  it("accepts only the closed, privacy-safe evidence shape", () => {
    const payload = {
      scenario: "destructive-incident",
      selectedRestorePoint: "2026-08-16T11:59:59.000Z",
      measured: {
        freezeMilliseconds: 14,
        restoreMilliseconds: 21,
        retryOutcome: "replayed_by_same_key",
        ordinaryInterruption: "same_key_replayed_exactly_once",
        catastrophicRestore: "acknowledged_transactions_after_selected_point_may_be_lost",
      },
      failures: [],
      correctiveActions: ["Repeat the exercise after provider changes."],
      memberDataIncluded: false,
      absoluteZeroDataLossGuarantee: false,
      providerEvidence: {
        provider: "local-supabase-simulation",
        pitrEnabled: true,
        pitrWindowDays: 7,
        backupRetentionDays: 30,
        evidenceRef: "local-recovery-simulation-v1",
        verifiedAt: "2026-08-16T12:00:00.000Z",
        productionReady: false,
      },
      mailIntegration: { provider: "mailpit", messageRef: "message-1", accepted: true },
    } as const;
    expect(isSafeRecoveryReportPayload(payload)).toBe(true);
    expect(isSafeRecoveryReportPayload({ ...payload, extra: "not allowed" })).toBe(false);
    expect(isSafeRecoveryReportPayload({ ...payload, correctiveActions: ["Contact member@example.test"] })).toBe(false);
    expect(isSafeRecoveryReportPayload({ ...payload, measured: { ...payload.measured, nested: { token: "secret" } } })).toBe(false);
    expect(isSafeRecoveryReportPayload({
      ...payload,
      providerEvidence: { ...payload.providerEvidence, provider: "managed-postgres", productionReady: false },
    })).toBe(false);
    expect(isSafeRecoveryReportPayload({
      ...payload,
      mailIntegration: { ...payload.mailIntegration, provider: "untrusted-mailer" },
    })).toBe(false);
  });
});
