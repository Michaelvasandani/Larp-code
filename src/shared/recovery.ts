/**
 * Provider-independent recovery invariants. The database and the local
 * rehearsal use the same vocabulary so an exercise cannot accidentally imply
 * a stronger durability guarantee than the managed restore point provides.
 */

export const MANAGED_PITR_WINDOW_DAYS = 7 as const;
export const BACKUP_RETENTION_CEILING_DAYS = 30 as const;
const MANAGED_PITR_WINDOW_MS = MANAGED_PITR_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const REQUIRED_RECOVERY_CHECKS = [
  "schemaVersion",
  "grantsAndRls",
  "authAccess",
  "snapshotContracts",
  "commandContracts",
  "idempotencyRecords",
  "memberCommitments",
  "lifecycleInvariants",
  "realtimePublication",
  "scheduledJobs",
  "retentionCutoffs",
  "mailIntegration",
  "providerEvidence",
] as const;

export type RecoveryCheck = (typeof REQUIRED_RECOVERY_CHECKS)[number];
export type RecoveryEvidence = Partial<Record<RecoveryCheck, boolean>>;
export type RecoveryValidation = {
  readyToReopen: boolean;
  failedChecks: RecoveryCheck[];
};

const RECOVERY_REPORT_KEYS = [
  "scenario",
  "selectedRestorePoint",
  "measured",
  "failures",
  "correctiveActions",
  "memberDataIncluded",
  "absoluteZeroDataLossGuarantee",
  "providerEvidence",
  "mailIntegration",
] as const;
const RECOVERY_MEASURED_KEYS = [
  "freezeMilliseconds",
  "restoreMilliseconds",
  "retryOutcome",
  "ordinaryInterruption",
  "catastrophicRestore",
] as const;
const PROHIBITED_REPORT_STRING = /(?:email|otp|token|password|secret|credential|member\s*data|challenge\s*data|snapshot|solve|pet|progress|display\s*name|@)/i;

export type RecoveryReportPayload = {
  scenario: "destructive-incident" | "ordinary-interruption";
  selectedRestorePoint: string;
  measured: {
    freezeMilliseconds: number;
    restoreMilliseconds: number;
    retryOutcome: string;
    ordinaryInterruption: string;
    catastrophicRestore: string;
  };
  failures: string[];
  correctiveActions: string[];
  memberDataIncluded: false;
  absoluteZeroDataLossGuarantee: false;
  providerEvidence: {
    provider: "managed-postgres" | "local-supabase-simulation";
    pitrEnabled: true;
    pitrWindowDays: 7;
    backupRetentionDays: number;
    evidenceRef: string;
    verifiedAt: string;
    productionReady: boolean;
  };
  mailIntegration: {
    provider: "resend" | "mailpit";
    messageRef: string;
    accepted: true;
  };
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function containsProhibitedString(value: unknown): boolean {
  if (typeof value === "string") return PROHIBITED_REPORT_STRING.test(value);
  if (Array.isArray(value)) return value.some(containsProhibitedString);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) => {
    const allowlistedKey = RECOVERY_REPORT_KEYS.includes(key as (typeof RECOVERY_REPORT_KEYS)[number])
      || RECOVERY_MEASURED_KEYS.includes(key as (typeof RECOVERY_MEASURED_KEYS)[number]);
    return (!allowlistedKey && PROHIBITED_REPORT_STRING.test(key)) || containsProhibitedString(nested);
  });
}

export function isSafeRecoveryReportPayload(value: unknown): value is RecoveryReportPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  if (!exactKeys(report, RECOVERY_REPORT_KEYS) || containsProhibitedString(report)) return false;
  if ((report.scenario !== "destructive-incident" && report.scenario !== "ordinary-interruption")
    || typeof report.selectedRestorePoint !== "string"
    || Number.isNaN(Date.parse(report.selectedRestorePoint))
    || report.memberDataIncluded !== false
    || report.absoluteZeroDataLossGuarantee !== false
    || !Array.isArray(report.failures) || !report.failures.every((item) => typeof item === "string")
    || !Array.isArray(report.correctiveActions) || !report.correctiveActions.every((item) => typeof item === "string")) return false;
  if (typeof report.measured !== "object" || report.measured === null || Array.isArray(report.measured)) return false;
  const measured = report.measured as Record<string, unknown>;
  if (typeof report.providerEvidence !== "object" || report.providerEvidence === null || Array.isArray(report.providerEvidence)
    || typeof report.mailIntegration !== "object" || report.mailIntegration === null || Array.isArray(report.mailIntegration)) return false;
  const providerEvidence = report.providerEvidence as Record<string, unknown>;
  const mailIntegration = report.mailIntegration as Record<string, unknown>;
  return exactKeys(measured, RECOVERY_MEASURED_KEYS)
    && Number.isInteger(measured.freezeMilliseconds) && (measured.freezeMilliseconds as number) >= 0
    && Number.isInteger(measured.restoreMilliseconds) && (measured.restoreMilliseconds as number) >= 0
    && Object.entries(measured).filter(([key]) => !["freezeMilliseconds", "restoreMilliseconds"].includes(key))
      .every(([, item]) => typeof item === "string")
    && exactKeys(providerEvidence, ["provider", "pitrEnabled", "pitrWindowDays", "backupRetentionDays", "evidenceRef", "verifiedAt", "productionReady"])
    && (providerEvidence.provider === "managed-postgres" || providerEvidence.provider === "local-supabase-simulation")
    && providerEvidence.pitrEnabled === true
    && providerEvidence.pitrWindowDays === 7
    && typeof providerEvidence.backupRetentionDays === "number"
    && Number.isInteger(providerEvidence.backupRetentionDays)
    && providerEvidence.backupRetentionDays >= 7
    && providerEvidence.backupRetentionDays <= 30
    && typeof providerEvidence.evidenceRef === "string"
    && typeof providerEvidence.verifiedAt === "string"
    && !Number.isNaN(Date.parse(providerEvidence.verifiedAt))
    && typeof providerEvidence.productionReady === "boolean"
    && providerEvidence.productionReady === (providerEvidence.provider === "managed-postgres")
    && exactKeys(mailIntegration, ["provider", "messageRef", "accepted"])
    && (mailIntegration.provider === "resend" || mailIntegration.provider === "mailpit")
    && mailIntegration.accepted === true
    && typeof mailIntegration.messageRef === "string";
}

export const DURABILITY_BEHAVIOR = Object.freeze({
  ordinaryInterruption: "Ordinary popup, worker, or network interruption recovers exactly once by retrying the same idempotency key.",
  catastrophicRestore: "A catastrophic restore can lose acknowledged transactions after the selected safe recovery point.",
  absoluteGuarantee: "No absolute zero-data-loss guarantee is made.",
});

export function selectLatestSafeRecoveryPoint({
  faultAt,
  candidates,
}: {
  faultAt: string;
  candidates: readonly string[];
}): string {
  const faultMilliseconds = Date.parse(faultAt);
  if (Number.isNaN(faultMilliseconds)) throw new Error("Fault time must be a valid timestamp.");
  const earliestSafeMilliseconds = faultMilliseconds - MANAGED_PITR_WINDOW_MS;
  const safePoints = candidates
    .map((candidate) => ({ candidate, milliseconds: Date.parse(candidate) }))
    .filter(({ milliseconds }) => !Number.isNaN(milliseconds)
      && milliseconds >= earliestSafeMilliseconds
      && milliseconds < faultMilliseconds)
    .sort((left, right) => right.milliseconds - left.milliseconds);
  const selected = safePoints[0]?.candidate;
  if (!selected) throw new Error("No safe recovery point exists before the fault in the managed seven-day window.");
  return selected;
}

export function validateRecoveryEvidence(evidence: RecoveryEvidence): RecoveryValidation {
  const failedChecks = REQUIRED_RECOVERY_CHECKS.filter((check) => evidence[check] !== true);
  return { readyToReopen: failedChecks.length === 0, failedChecks: [...failedChecks] };
}

export type RecoveryReport = {
  generatedAt: string;
  incident: string;
  scenario: string;
  selectedRestorePoint: string;
  faultAt: string;
  validation: RecoveryValidation;
  measured: {
    freezeMilliseconds: number;
    restoreMilliseconds: number;
    retryOutcome: "replayed_by_same_key" | "acknowledged_after_restore_point_may_be_lost";
  };
  failures: string[];
  correctiveActions: string[];
  memberDataIncluded: false;
  durability: typeof DURABILITY_BEHAVIOR;
};

export function createRecoveryReport(input: Omit<RecoveryReport, "generatedAt" | "memberDataIncluded" | "durability">): RecoveryReport {
  return Object.freeze({
    ...input,
    generatedAt: new Date().toISOString(),
    memberDataIncluded: false,
    durability: DURABILITY_BEHAVIOR,
  });
}
