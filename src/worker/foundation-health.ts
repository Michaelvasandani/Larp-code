export type FoundationHealth = {
  service: "larp-code";
  schemaVersion: number;
  serverTime: string;
  minimumClientVersion?: string;
  updateUrl?: string;
  minimumClientReason?: "security" | "correctness";
  /** Safe operational metadata; non-open means Member Data is unavailable. */
  recoveryPhase?: "open" | "frozen" | "restoring";
  // These fields are negotiation metadata. Unknown future integer versions
  // must survive parsing so the client can apply its minimum-version floor
  // and return a safe update-required response.
  snapshotContractVersion?: number;
  commandContractVersion?: number;
  supportedSnapshotContractVersions?: number[];
  supportedCommandContractVersions?: number[];
};

export function isFoundationHealth(value: unknown): value is FoundationHealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return health.service === "larp-code"
    && typeof health.schemaVersion === "number"
    && Number.isInteger(health.schemaVersion)
    && typeof health.serverTime === "string"
    && !Number.isNaN(Date.parse(health.serverTime))
    && (health.minimumClientVersion === undefined || typeof health.minimumClientVersion === "string")
    && (health.updateUrl === undefined || typeof health.updateUrl === "string")
    && (health.minimumClientReason === undefined || health.minimumClientReason === "security" || health.minimumClientReason === "correctness")
    && (health.recoveryPhase === undefined || health.recoveryPhase === "open" || health.recoveryPhase === "frozen" || health.recoveryPhase === "restoring")
    && (health.snapshotContractVersion === undefined || (typeof health.snapshotContractVersion === "number" && Number.isInteger(health.snapshotContractVersion)))
    && (health.commandContractVersion === undefined || (typeof health.commandContractVersion === "number" && Number.isInteger(health.commandContractVersion)))
    && (health.supportedSnapshotContractVersions === undefined || (Array.isArray(health.supportedSnapshotContractVersions)
      && health.supportedSnapshotContractVersions.every((version) => typeof version === "number" && Number.isInteger(version))))
    && (health.supportedCommandContractVersions === undefined || (Array.isArray(health.supportedCommandContractVersions)
      && health.supportedCommandContractVersions.every((version) => typeof version === "number" && Number.isInteger(version))));
}
