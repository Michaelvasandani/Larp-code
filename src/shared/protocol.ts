/**
 * The only popup/worker contract. Domain payloads can grow behind these
 * discriminants, but a client must never silently consume another version.
 */
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type WorkerEvidence = {
  bootId: string;
  bootCount: number;
  sessionRestoredFromStorage: boolean;
};

export type SnapshotFreshness = {
  revision: string;
  fetchedAt: string;
};

export type CompatibilityMetadata = {
  minimumClientVersion: string;
};

export type BackendHealth = {
  status: "reachable";
  schemaVersion: number;
};

type SnapshotMetadata = {
  contractVersion: ProtocolVersion;
  authoritativeServerTime: string;
  freshness: SnapshotFreshness;
  compatibility: CompatibilityMetadata;
  backend: BackendHealth;
  worker: WorkerEvidence;
};

export type SignedOutSnapshot = SnapshotMetadata & {
  kind: "signed_out";
};

// These discriminants are intentionally present in the foundation contract;
// their domain payloads belong to later implementation tickets.
export type SetupRequiredSnapshot = SnapshotMetadata & {
  kind: "setup_required";
};

export type InvitationSnapshot = SnapshotMetadata & {
  kind: "invitation";
};

export type ScheduledSnapshot = SnapshotMetadata & {
  kind: "scheduled";
};

export type ActiveSnapshot = SnapshotMetadata & {
  kind: "active";
};

export type TerminalSnapshot = SnapshotMetadata & {
  kind: "terminal";
};

export type AppSnapshot =
  | SignedOutSnapshot
  | SetupRequiredSnapshot
  | InvitationSnapshot
  | ScheduledSnapshot
  | ActiveSnapshot
  | TerminalSnapshot;

export type PopupRequest = {
  version: ProtocolVersion;
  type: "get_snapshot";
};

export type ProtocolErrorCode =
  | "bad_request"
  | "connection_unavailable"
  | "incompatible_client"
  | "internal"
  | "unauthorized";

export type ProtocolError = {
  code: ProtocolErrorCode;
  message: string;
  diagnosticId?: string;
};

export type PopupResponse =
  | { ok: true; snapshot: AppSnapshot }
  | { ok: false; error: ProtocolError };

export type WorkerEvent =
  | { version: ProtocolVersion; type: "snapshot_invalidated"; snapshot: AppSnapshot }
  | { version: ProtocolVersion; type: "realtime_status"; status: "connecting" | "subscribed" | "closed" | "error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isWorkerEvidence(value: unknown): value is WorkerEvidence {
  if (!isRecord(value) || !hasExactKeys(value, ["bootId", "bootCount", "sessionRestoredFromStorage"])) return false;
  return isString(value.bootId) && typeof value.bootCount === "number" && Number.isInteger(value.bootCount)
    && typeof value.sessionRestoredFromStorage === "boolean";
}

function isSnapshot(value: unknown): value is AppSnapshot {
  if (!isRecord(value)) return false;
  const keys = [
    "contractVersion",
    "kind",
    "authoritativeServerTime",
    "freshness",
    "compatibility",
    "backend",
    "worker",
  ] as const;
  if (!hasExactKeys(value, keys)) return false;
  if (value.contractVersion !== PROTOCOL_VERSION || !isString(value.authoritativeServerTime) || !isWorkerEvidence(value.worker)) {
    return false;
  }
  if (!isRecord(value.freshness) || !hasExactKeys(value.freshness, ["revision", "fetchedAt"])
    || !isString(value.freshness.revision) || !isString(value.freshness.fetchedAt)) return false;
  if (!isRecord(value.compatibility) || !hasExactKeys(value.compatibility, ["minimumClientVersion"])
    || !isString(value.compatibility.minimumClientVersion)) return false;
  if (!isRecord(value.backend) || !hasExactKeys(value.backend, ["status", "schemaVersion"])
    || value.backend.status !== "reachable" || typeof value.backend.schemaVersion !== "number") return false;
  return ["signed_out", "setup_required", "invitation", "scheduled", "active", "terminal"].includes(String(value.kind));
}

export function isPopupRequest(value: unknown): value is PopupRequest {
  return isRecord(value) && hasExactKeys(value, ["version", "type"])
    && value.version === PROTOCOL_VERSION && value.type === "get_snapshot";
}

export function isPopupResponse(value: unknown): value is PopupResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return hasExactKeys(value, ["ok", "snapshot"]) && isSnapshot(value.snapshot);
  if (!hasExactKeys(value, ["ok", "error"]) || !isRecord(value.error)) return false;
  if (!hasExactKeys(value.error, ["code", "message"]) && !hasExactKeys(value.error, ["code", "message", "diagnosticId"])) return false;
  return ["bad_request", "connection_unavailable", "incompatible_client", "internal", "unauthorized"].includes(String(value.error.code))
    && isString(value.error.message)
    && (value.error.diagnosticId === undefined || isString(value.error.diagnosticId));
}
