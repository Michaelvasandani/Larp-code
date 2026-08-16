/**
 * The published contract window. A release may add a new version only after
 * the backend serves it alongside the immediately preceding version.
 */
export const CURRENT_SNAPSHOT_CONTRACT_VERSION = 2 as const;
export const PREVIOUS_SNAPSHOT_CONTRACT_VERSION = 1 as const;
export const CURRENT_COMMAND_CONTRACT_VERSION = 2 as const;
export const PREVIOUS_COMMAND_CONTRACT_VERSION = 1 as const;

export type SupportedSnapshotContractVersion =
  | typeof CURRENT_SNAPSHOT_CONTRACT_VERSION
  | typeof PREVIOUS_SNAPSHOT_CONTRACT_VERSION;
export type SupportedCommandContractVersion =
  | typeof CURRENT_COMMAND_CONTRACT_VERSION
  | typeof PREVIOUS_COMMAND_CONTRACT_VERSION;

export const SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS = [
  PREVIOUS_SNAPSHOT_CONTRACT_VERSION,
  CURRENT_SNAPSHOT_CONTRACT_VERSION,
] as const;
export const SUPPORTED_COMMAND_CONTRACT_VERSIONS = [
  PREVIOUS_COMMAND_CONTRACT_VERSION,
  CURRENT_COMMAND_CONTRACT_VERSION,
] as const;

export type ContractCompatibility = Readonly<{
  snapshotContractVersion: SupportedSnapshotContractVersion;
  commandContractVersion: SupportedCommandContractVersion;
  supportedSnapshotContractVersions: readonly SupportedSnapshotContractVersion[];
  supportedCommandContractVersions: readonly SupportedCommandContractVersion[];
}>;

export const CONTRACT_COMPATIBILITY: ContractCompatibility = {
  snapshotContractVersion: CURRENT_SNAPSHOT_CONTRACT_VERSION,
  commandContractVersion: CURRENT_COMMAND_CONTRACT_VERSION,
  supportedSnapshotContractVersions: SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS,
  supportedCommandContractVersions: SUPPORTED_COMMAND_CONTRACT_VERSIONS,
};

export function isSupportedSnapshotContractVersion(value: unknown): value is SupportedSnapshotContractVersion {
  return SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS.includes(value as SupportedSnapshotContractVersion);
}

export function isSupportedCommandContractVersion(value: unknown): value is SupportedCommandContractVersion {
  return SUPPORTED_COMMAND_CONTRACT_VERSIONS.includes(value as SupportedCommandContractVersion);
}

export function isContractCompatibility(value: unknown): value is ContractCompatibility {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return isSupportedSnapshotContractVersion(candidate.snapshotContractVersion)
    && isSupportedCommandContractVersion(candidate.commandContractVersion)
    && Array.isArray(candidate.supportedSnapshotContractVersions)
    && candidate.supportedSnapshotContractVersions.every(isSupportedSnapshotContractVersion)
    && Array.isArray(candidate.supportedCommandContractVersions)
    && candidate.supportedCommandContractVersions.every(isSupportedCommandContractVersion);
}

/**
 * Selects the requested envelope when the backend advertises it. Unknown
 * future metadata is ignored by this parser; only a confirmed absence of both
 * local versions returns null and lets the caller produce update-required.
 */
export function negotiateResponseContractVersion(
  requested: unknown,
  backendSupported: readonly unknown[] | undefined,
): SupportedSnapshotContractVersion | null {
  if (!isSupportedSnapshotContractVersion(requested)) return null;
  if (!backendSupported || backendSupported.length === 0) return requested;
  const knownBackendVersions = backendSupported.filter(isSupportedSnapshotContractVersion);
  return knownBackendVersions.includes(requested) ? requested : null;
}
