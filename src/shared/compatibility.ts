import type { CompatibilityMetadata } from "./protocol";

/**
 * Contract versions are intentionally consecutive. During a rollout the
 * backend must keep the current and immediately preceding published version;
 * a later release may advance these constants as part of an explicit
 * expand-then-contract boundary.
 */
export const CURRENT_SNAPSHOT_CONTRACT_VERSION = 1 as const;
export const PREVIOUS_SNAPSHOT_CONTRACT_VERSION = 0 as const;
export const CURRENT_COMMAND_CONTRACT_VERSION = 1 as const;
export const PREVIOUS_COMMAND_CONTRACT_VERSION = 0 as const;

export type SupportedSnapshotContractVersion =
  | typeof CURRENT_SNAPSHOT_CONTRACT_VERSION
  | typeof PREVIOUS_SNAPSHOT_CONTRACT_VERSION;
export type SupportedCommandContractVersion =
  | typeof CURRENT_COMMAND_CONTRACT_VERSION
  | typeof PREVIOUS_COMMAND_CONTRACT_VERSION;

export const SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS = [
  PREVIOUS_SNAPSHOT_CONTRACT_VERSION,
  CURRENT_SNAPSHOT_CONTRACT_VERSION,
] as const satisfies readonly SupportedSnapshotContractVersion[];
export const SUPPORTED_COMMAND_CONTRACT_VERSIONS = [
  PREVIOUS_COMMAND_CONTRACT_VERSION,
  CURRENT_COMMAND_CONTRACT_VERSION,
] as const satisfies readonly SupportedCommandContractVersion[];

export const COMPATIBILITY_BACKFILL_VERSION = "ticket-37-contract-v1" as const;

export type BackfillState = Readonly<{
  migrationVersion: typeof COMPATIBILITY_BACKFILL_VERSION;
  cursor: string | null;
  processedRows: number;
  completed: boolean;
}>;

/**
 * Pure model of the database cursor used by the compatibility backfill. The
 * cursor is monotonic, duplicate input rows are ignored, and a completed
 * state is immutable so retries cannot reapply a batch.
 */
export function advanceBackfill(
  state: BackfillState,
  orderedIds: readonly string[],
  batchSize: number,
): BackfillState {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("Backfill batch size must be between 1 and 1000.");
  }
  if (state.completed) return state;
  const candidates = [...new Set(orderedIds)]
    .filter((id) => state.cursor === null || id > state.cursor)
    .sort();
  const batch = candidates.slice(0, batchSize);
  if (batch.length === 0) {
    return { ...state, completed: true };
  }
  return {
    ...state,
    cursor: batch[batch.length - 1]!,
    processedRows: state.processedRows + batch.length,
    completed: batch.length < batchSize,
  };
}

export function isSupportedSnapshotContractVersion(value: unknown): value is SupportedSnapshotContractVersion {
  return SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS.includes(value as SupportedSnapshotContractVersion);
}

export function isSupportedCommandContractVersion(value: unknown): value is SupportedCommandContractVersion {
  return SUPPORTED_COMMAND_CONTRACT_VERSIONS.includes(value as SupportedCommandContractVersion);
}

export type UpdateRequiredCapabilities = Readonly<{
  canRequestUpdate: true;
  canSignOut: true;
  canEraseLocalData: true;
  canReadMemberData: false;
  canMutateMemberData: false;
}>;

export function updateRequiredCapabilities(): UpdateRequiredCapabilities {
  return {
    canRequestUpdate: true,
    canSignOut: true,
    canEraseLocalData: true,
    canReadMemberData: false,
    canMutateMemberData: false,
  };
}

/**
 * Compares the deliberately small dotted numeric versions shipped by the
 * extension and backend. Pre-release/build metadata is not part of the
 * compatibility contract, so malformed values are treated as incompatible.
 */
export function compareClientVersions(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string): number[] | null => {
    if (!/^\d+(?:\.\d+){0,3}$/.test(value)) return null;
    return value.split(".").map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export function requiresClientUpdate(
  compatibility: Pick<CompatibilityMetadata, "minimumClientVersion">,
  clientVersion: string,
): boolean {
  return compareClientVersions(clientVersion, compatibility.minimumClientVersion) < 0;
}
