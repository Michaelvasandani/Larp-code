export const INVITATION_TERMINAL_RETENTION_DAYS = 30 as const;
export const CHALLENGE_RECORD_RETENTION_DAYS = 365 as const;
export const DIAGNOSTIC_RETENTION_DAYS = 30 as const;
export const SECURITY_AUDIT_RETENTION_DAYS = 90 as const;
export const MAX_BACKUP_RETENTION_DAYS = 30 as const;

function addDays(value: string, days: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("A valid terminal timestamp is required.");
  return new Date(timestamp + days * 86_400_000).toISOString();
}

export type RetentionWindow = {
  kind: "invitation" | "challenge";
  terminalAt: string;
  expiresAt: string;
  cleanupEligibleAt: string;
};

export function retentionWindow(kind: RetentionWindow["kind"], terminalAt: string): RetentionWindow {
  const expiresAt = addDays(terminalAt, kind === "invitation"
    ? INVITATION_TERMINAL_RETENTION_DAYS
    : CHALLENGE_RECORD_RETENTION_DAYS);
  return { kind, terminalAt, expiresAt, cleanupEligibleAt: expiresAt };
}

/** Logical retention is strict: a record is absent at its expiry instant. */
export function isWithinRetention(kind: RetentionWindow["kind"], terminalAt: string, authoritativeNow: string): boolean {
  return Date.parse(authoritativeNow) < Date.parse(retentionWindow(kind, terminalAt).expiresAt);
}

/**
 * The database keeps this metadata as a repository-owned retention ledger.
 * Diagnostic and security/audit payloads are not stored by this extension;
 * backup copies are provider-managed and therefore represented as a maximum
 * window rather than a local copy.
 */
export function deletionRetentionMetadata(deletedAt: string) {
  return {
    invitation: addDays(deletedAt, INVITATION_TERMINAL_RETENTION_DAYS),
    challenge: addDays(deletedAt, CHALLENGE_RECORD_RETENTION_DAYS),
    diagnostic: addDays(deletedAt, DIAGNOSTIC_RETENTION_DAYS),
    securityAudit: addDays(deletedAt, SECURITY_AUDIT_RETENTION_DAYS),
    backup: addDays(deletedAt, MAX_BACKUP_RETENTION_DAYS),
  } as const;
}
