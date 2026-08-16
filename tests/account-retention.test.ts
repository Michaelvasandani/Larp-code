import { describe, expect, it } from "vitest";

import {
  CHALLENGE_RECORD_RETENTION_DAYS,
  DIAGNOSTIC_RETENTION_DAYS,
  INVITATION_TERMINAL_RETENTION_DAYS,
  MAX_BACKUP_RETENTION_DAYS,
  SECURITY_AUDIT_RETENTION_DAYS,
  deletionRetentionMetadata,
  retentionWindow,
  isWithinRetention,
} from "../src/worker/account-retention";

const terminalAt = "2026-08-16T00:00:00.000Z";

describe("finite deletion retention seam", () => {
  it("publishes the policy windows", () => {
    expect(INVITATION_TERMINAL_RETENTION_DAYS).toBe(30);
    expect(CHALLENGE_RECORD_RETENTION_DAYS).toBe(365);
    expect(DIAGNOSTIC_RETENTION_DAYS).toBe(30);
    expect(SECURITY_AUDIT_RETENTION_DAYS).toBe(90);
    expect(MAX_BACKUP_RETENTION_DAYS).toBe(30);
  });

  it("exposes the repository-owned non-content retention ledger windows", () => {
    expect(deletionRetentionMetadata(terminalAt)).toEqual({
      invitation: "2026-09-15T00:00:00.000Z",
      challenge: "2027-08-16T00:00:00.000Z",
      diagnostic: "2026-09-15T00:00:00.000Z",
      securityAudit: "2026-11-14T00:00:00.000Z",
      backup: "2026-09-15T00:00:00.000Z",
    });
  });

  it("uses an exclusive expiry boundary for logical access", () => {
    const invitation = retentionWindow("invitation", terminalAt);
    expect(invitation.expiresAt).toBe("2026-09-15T00:00:00.000Z");
    expect(isWithinRetention("invitation", terminalAt, "2026-09-14T23:59:59.999Z")).toBe(true);
    expect(isWithinRetention("invitation", terminalAt, invitation.expiresAt)).toBe(false);
  });

  it("keeps Challenge terminal records for one year while exposing cleanup eligibility", () => {
    const challenge = retentionWindow("challenge", terminalAt);
    expect(challenge.expiresAt).toBe("2027-08-16T00:00:00.000Z");
    expect(challenge.cleanupEligibleAt).toBe(challenge.expiresAt);
    expect(isWithinRetention("challenge", terminalAt, "2027-08-15T23:59:59.999Z")).toBe(true);
    expect(isWithinRetention("challenge", terminalAt, challenge.expiresAt)).toBe(false);
  });
});
