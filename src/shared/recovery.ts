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
] as const;

export type RecoveryCheck = (typeof REQUIRED_RECOVERY_CHECKS)[number];
export type RecoveryEvidence = Partial<Record<RecoveryCheck, boolean>>;
export type RecoveryValidation = {
  readyToReopen: boolean;
  failedChecks: RecoveryCheck[];
};

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
