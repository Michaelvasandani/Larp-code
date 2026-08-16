import { isMemberAccount, type MemberAccount } from "./member-account";

export type { MemberAccount } from "./member-account";

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
  email: string;
};

export type MemberAccountSnapshot = SnapshotMetadata & {
  kind: "account";
  account: MemberAccount;
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
  | MemberAccountSnapshot
  | InvitationSnapshot
  | ScheduledSnapshot
  | ActiveSnapshot
  | TerminalSnapshot;

export const SIGN_IN_STATUS_METADATA = {
  ready: { message: "Enter your email to request a six-digit sign-in code.", codeEntry: false },
  requesting_code: { message: "Requesting a sign-in code…", codeEntry: false },
  code_sent: {
    message: "A six-digit code can be entered now. Responses stay the same whether or not an address has a Member Account.",
    codeEntry: true,
    optionalField: "resendAvailableAt",
  },
  resend_cooldown: { message: "Please wait before requesting another code.", codeEntry: true, optionalField: "resendAvailableAt" },
  verifying: { message: "Checking the code…", codeEntry: true },
  invalid_code: { message: "That code is not valid. Check the six digits and try again.", codeEntry: true },
  expired_code: { message: "That code has expired. Request another six-digit code.", codeEntry: true },
  rate_limited: { message: "Too many requests. Please wait and try again.", codeEntry: true, optionalField: "retryAfterSeconds" },
  service_unavailable: { message: "The connection is unavailable. Your account has not been changed.", codeEntry: false },
} as const;

export type SignInStatus = keyof typeof SIGN_IN_STATUS_METADATA;

export type SignInState =
  | { status: "ready" }
  | { status: "requesting_code" }
  | { status: "code_sent"; resendAvailableAt?: string }
  | { status: "resend_cooldown"; resendAvailableAt?: string }
  | { status: "verifying" }
  | { status: "invalid_code" }
  | { status: "expired_code" }
  | { status: "rate_limited"; retryAfterSeconds?: number }
  | { status: "service_unavailable" };

export type PopupRequest =
  | {
  version: ProtocolVersion;
  type: "get_snapshot";
  }
  | {
      version: ProtocolVersion;
      type: "request_email_otp" | "resend_email_otp";
      email: string;
    }
  | {
      version: ProtocolVersion;
      type: "verify_email_otp";
      email: string;
      token: string;
    }
  | {
      version: ProtocolVersion;
      type: "create_member_account";
      displayName: string;
      adultConfirmed: boolean;
      consentAccepted: boolean;
    }
  | {
      version: ProtocolVersion;
      type: "sign_out";
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
  | { ok: true; snapshot: AppSnapshot; auth?: SignInState }
  | { ok: true; auth: SignInState; snapshot?: AppSnapshot }
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
  if (!hasExactKeys(value, keys)
    && !hasExactKeys(value, [...keys, "email"])
    && !hasExactKeys(value, [...keys, "account"])) return false;
  if (value.contractVersion !== PROTOCOL_VERSION || !isString(value.authoritativeServerTime) || !isWorkerEvidence(value.worker)) {
    return false;
  }
  if (!isRecord(value.freshness) || !hasExactKeys(value.freshness, ["revision", "fetchedAt"])
    || !isString(value.freshness.revision) || !isString(value.freshness.fetchedAt)) return false;
  if (!isRecord(value.compatibility) || !hasExactKeys(value.compatibility, ["minimumClientVersion"])
    || !isString(value.compatibility.minimumClientVersion)) return false;
  if (!isRecord(value.backend) || !hasExactKeys(value.backend, ["status", "schemaVersion"])
    || value.backend.status !== "reachable" || typeof value.backend.schemaVersion !== "number") return false;
  if (value.kind === "setup_required") return hasExactKeys(value, [...keys, "email"]) && isString(value.email);
  if (value.kind === "account") return hasExactKeys(value, [...keys, "account"]) && isMemberAccount(value.account);
  return ["signed_out", "invitation", "scheduled", "active", "terminal"].includes(String(value.kind))
    && hasExactKeys(value, keys);
}

export function isPopupRequest(value: unknown): value is PopupRequest {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || typeof value.type !== "string") return false;
  if (value.type === "get_snapshot" || value.type === "sign_out") {
    return hasExactKeys(value, ["version", "type"]);
  }
  if (value.type === "request_email_otp" || value.type === "resend_email_otp") {
    return hasExactKeys(value, ["version", "type", "email"]) && isString(value.email);
  }
  if (value.type === "create_member_account") {
    return hasExactKeys(value, ["version", "type", "displayName", "adultConfirmed", "consentAccepted"])
      && typeof value.displayName === "string"
      && typeof value.adultConfirmed === "boolean"
      && typeof value.consentAccepted === "boolean";
  }
  return value.type === "verify_email_otp"
    && hasExactKeys(value, ["version", "type", "email", "token"])
    && isString(value.email)
    && typeof value.token === "string";
}

function isSignInState(value: unknown): value is SignInState {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  const metadata = SIGN_IN_STATUS_METADATA[value.status as SignInStatus];
  if (!metadata) return false;
  if (!("optionalField" in metadata)) return hasExactKeys(value, ["status"]);
  if (!hasExactKeys(value, ["status"]) && !hasExactKeys(value, ["status", metadata.optionalField])) return false;
  const optionalValue = value[metadata.optionalField];
  if (optionalValue === undefined) return true;
  return metadata.optionalField === "resendAvailableAt"
    ? isString(optionalValue)
    : typeof optionalValue === "number"
      && Number.isInteger(optionalValue)
      && optionalValue >= 0;
}

export function isPopupResponse(value: unknown): value is PopupResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    const hasSnapshot = value.snapshot !== undefined;
    const hasAuth = value.auth !== undefined;
    if (!hasSnapshot && !hasAuth) return false;
    if (hasSnapshot && !isSnapshot(value.snapshot)) return false;
    if (hasAuth && !isSignInState(value.auth)) return false;
    const expectedKeys = hasSnapshot && hasAuth
      ? ["ok", "snapshot", "auth"]
      : hasSnapshot
        ? ["ok", "snapshot"]
        : ["ok", "auth"];
    return hasExactKeys(value, expectedKeys);
  }
  if (!hasExactKeys(value, ["ok", "error"]) || !isRecord(value.error)) return false;
  if (!hasExactKeys(value.error, ["code", "message"]) && !hasExactKeys(value.error, ["code", "message", "diagnosticId"])) return false;
  return ["bad_request", "connection_unavailable", "incompatible_client", "internal", "unauthorized"].includes(String(value.error.code))
    && isString(value.error.message)
    && (value.error.diagnosticId === undefined || isString(value.error.diagnosticId));
}
