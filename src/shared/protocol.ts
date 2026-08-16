import { isMemberAccount, type MemberAccount } from "./member-account";

export type { MemberAccount } from "./member-account";

/**
 * The only popup/worker contract. Domain payloads can grow behind these
 * discriminants, but a client must never silently consume another version.
 */
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Domain commands have their own version so command rollout can evolve independently. */
export const TRANSACTION_COMMAND_VERSION = 1 as const;
export type TransactionCommandVersion = typeof TRANSACTION_COMMAND_VERSION;
export type TransactionCommandKind =
  | "update_display_name"
  | "create_invitation"
  | "accept_invitation"
  | "revoke_invitation"
  | "decline_invitation"
  | "cancel_challenge"
  | "create_solve";

type PendingCommandBase = {
  version: TransactionCommandVersion;
  idempotencyKey: string;
  memberId: string;
  memberEmail: string;
  requestedAt: string;
};

export type InvitationCommandIntent = Readonly<{
  invitedEmail: string;
  timeZone: string;
  startDate: string;
  deadlineDate: string;
  problemSetVersionId: string;
}>;

export type InvitationTerminalCommandIntent = Readonly<{
  invitationId: string;
}>;

export type PendingCommand =
  | (PendingCommandBase & {
      kind: "update_display_name";
      intent: { displayName: string };
    })
  | (PendingCommandBase & {
      kind: "create_invitation";
      intent: InvitationCommandIntent;
    })
  | (PendingCommandBase & {
      kind: "accept_invitation";
      intent: InvitationTerminalCommandIntent;
    })
  | (PendingCommandBase & {
      kind: "revoke_invitation" | "decline_invitation";
      intent: InvitationTerminalCommandIntent;
    })
  | (PendingCommandBase & {
      kind: "cancel_challenge";
      intent: { challengeId: string };
    })
  | (PendingCommandBase & {
      kind: "create_solve";
      intent: { challengeId: string; problemId: string; affirmed: true };
    });

export type CommandOutcome =
  | {
      status: "applied";
      kind: TransactionCommandKind;
      idempotencyKey: string;
    }
  | {
      status: "rejected";
      kind: TransactionCommandKind;
      code: "unauthorized" | "validation" | "rate_limited";
      message: string;
    }
  | {
      status: "uncertain";
      kind: TransactionCommandKind;
      idempotencyKey: string;
      message: "Checking whether this completed.";
    };

export type UncertainCommandOutcome = Extract<CommandOutcome, { status: "uncertain" }>;

export function createUncertainCommandOutcome(
  idempotencyKey: string,
  kind: TransactionCommandKind = "update_display_name",
): UncertainCommandOutcome {
  return {
    status: "uncertain",
    kind,
    idempotencyKey,
    message: "Checking whether this completed.",
  };
}

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
  /** The one locally persisted command, when recovery is still required. */
  pendingCommand?: PendingCommand | null;
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

export type Invitation = Readonly<{
  id: string;
  inviterId: string;
  inviterDisplayName: string;
  invitedEmail: string;
  timeZone: string;
  startDate: string;
  deadlineDate: string;
  problemSetVersionId: string;
  status: "pending" | "accepted" | "revoked" | "declined" | "expired";
  createdAt: string;
  terminalActorId?: string | null;
  terminalAt?: string | null;
}>;

export type InvitationRole = "inviter" | "invitee";
export type InvitationAction = "accept" | "decline" | "revoke";
export type ChallengeStatus = "scheduled" | "active" | "canceled";
export type ChallengeAction = "cancel" | "solve";

export type ActivePaceStatus = "behind" | "on_pace_today" | "todays_pace_met";
export type ActivePetCondition = "healthy" | "hungry" | "sad" | "deteriorated";
export type ActiveEvolutionStage = 1 | 2 | 3 | 4;

export type ActiveMemberProgress = Readonly<{
  memberId: string;
  email: string;
  displayName: string;
  authority: "equal";
  creditedTotal: number;
  paceStatus: ActivePaceStatus;
  paceGap: Readonly<{
    previousTarget: number;
    currentTarget: number;
    gapToPreviousTarget: number;
    amountNeededToday: number;
    amountAhead: number;
    copy: string;
  }>;
}>;

export type ActiveChallengeProgress = Readonly<{
  problemSetVersionId: string;
  day: number;
  durationDays: number;
  expectedProgress: number;
  previousExpectedProgress: number;
  earlierExpectedProgress: number;
  pairProgress: number;
  petCondition: ActivePetCondition;
  currentEvolutionStage: ActiveEvolutionStage;
  highestEvolutionStage: ActiveEvolutionStage;
  members: readonly ActiveMemberProgress[];
}>;

export type InvitationSnapshot = SnapshotMetadata & {
  kind: "invitation";
  invitation: Invitation;
  details?: InvitationDetails;
  role?: InvitationRole;
  actions?: readonly InvitationAction[];
};

export type ScheduledSnapshot = SnapshotMetadata & {
  kind: "scheduled";
  challenge: ChallengeSnapshot;
  actions?: readonly ChallengeAction[];
};

export type ActiveSnapshot = SnapshotMetadata & {
  kind: "active";
  challenge: ChallengeSnapshot;
  progress: ActiveChallengeProgress;
  actions?: readonly ChallengeAction[];
};

export type TerminalSnapshot = SnapshotMetadata & {
  kind: "terminal";
  challenge?: ChallengeSnapshot;
  actions?: readonly ChallengeAction[];
};

export type AppSnapshot =
  | SignedOutSnapshot
  | SetupRequiredSnapshot
  | MemberAccountSnapshot
  | InvitationSnapshot
  | ScheduledSnapshot
  | ActiveSnapshot
  | TerminalSnapshot;

/** The identity and permissions shown to an authenticated invitee before acceptance. */
export type InvitationDetails = Readonly<{
  problemSetVersion: Readonly<{
    id: string;
    sourceRepository: string;
    sourceDataFile: string;
    sourceCommitSha: string;
    licenseNotice: string;
    nonAffiliationNotice: string;
    importedAt: string;
    problemCount: number;
  }>;
  partner: Readonly<{
    memberId: string;
    email: string;
    displayName: string;
  }>;
  sharedRecord: Readonly<{
    visibility: "both_members";
    authority: "equal";
    canEitherMemberEnd: true;
  }>;
}>;

export type InvitationDetailsRecord = Readonly<InvitationDetails & { invitation: Invitation }>;

export type ChallengeSnapshot = Readonly<{
  id: string;
  invitationId: string;
  timeZone: string;
  startDate: string;
  deadlineDate: string;
  problemSetVersionId: string;
  status: ChallengeStatus;
  createdAt: string;
  terminalActorId?: string | null;
  terminalAt?: string | null;
  /** Present only when the authoritative Challenge is Active. */
  progress?: ActiveChallengeProgress;
  members: readonly Readonly<{
    memberId: string;
    email: string;
    displayName: string;
    authority: "equal";
  }>[];
}>;

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
      type: "update_display_name";
      displayName: string;
    }
  | {
      version: ProtocolVersion;
      type: "create_invitation";
      invitedEmail: string;
      timeZone: string;
      startDate: string;
      deadlineDate: string;
    }
  | {
      version: ProtocolVersion;
      type: "accept_invitation" | "revoke_invitation" | "decline_invitation";
      invitationId: string;
    }
  | {
      version: ProtocolVersion;
      type: "cancel_challenge";
      challengeId: string;
    }
  | {
      version: ProtocolVersion;
      type: "credit_solve";
      challengeId: string;
      problemId: string;
      affirmed: boolean;
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
  | { ok: true; snapshot?: AppSnapshot; auth?: SignInState; command?: CommandOutcome }
  | { ok: false; error: ProtocolError };

export type WorkerEvent =
  | { version: ProtocolVersion; type: "snapshot_invalidated" }
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

function isInvitation(value: unknown): value is Invitation {
  if (!isRecord(value)) return false;
  const baseKeys = [
    "id", "inviterId", "inviterDisplayName", "invitedEmail", "timeZone", "startDate", "deadlineDate",
    "problemSetVersionId", "status", "createdAt",
  ];
  const optionalKeys = ["terminalActorId", "terminalAt"];
  const actual = Object.keys(value);
  if (!actual.every((key) => baseKeys.includes(key) || optionalKeys.includes(key))) return false;
  if (actual.filter((key) => baseKeys.includes(key)).length !== baseKeys.length) return false;
  return isString(value.id) && isString(value.inviterId) && isString(value.inviterDisplayName)
    && isString(value.invitedEmail)
    && isString(value.timeZone) && /^\d{4}-\d{2}-\d{2}$/.test(String(value.startDate))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(value.deadlineDate))
    && isString(value.problemSetVersionId)
    && ["pending", "accepted", "revoked", "declined", "expired"].includes(String(value.status))
    && isString(value.createdAt)
    && (value.terminalActorId === undefined || value.terminalActorId === null || isString(value.terminalActorId))
    && (value.terminalAt === undefined || value.terminalAt === null || isString(value.terminalAt));
}

export function isInvitationDetails(value: unknown): value is InvitationDetails {
  if (!isRecord(value) || !hasExactKeys(value, ["problemSetVersion", "partner", "sharedRecord"])) return false;
  if (!isRecord(value.problemSetVersion)
    || !hasExactKeys(value.problemSetVersion, ["id", "sourceRepository", "sourceDataFile", "sourceCommitSha", "licenseNotice", "nonAffiliationNotice", "importedAt", "problemCount"])
    || !isString(value.problemSetVersion.id)
    || !isString(value.problemSetVersion.sourceRepository)
    || !isString(value.problemSetVersion.sourceDataFile)
    || !/^[0-9a-f]{40}$/i.test(String(value.problemSetVersion.sourceCommitSha))
    || !isString(value.problemSetVersion.licenseNotice)
    || !isString(value.problemSetVersion.nonAffiliationNotice)
    || !isString(value.problemSetVersion.importedAt)
    || typeof value.problemSetVersion.problemCount !== "number"
    || !Number.isInteger(value.problemSetVersion.problemCount)
    || value.problemSetVersion.problemCount !== 150) return false;
  if (!isRecord(value.partner) || !hasExactKeys(value.partner, ["memberId", "email", "displayName"])
    || !isString(value.partner.memberId) || !isString(value.partner.email) || !isString(value.partner.displayName)) return false;
  return isRecord(value.sharedRecord)
    && hasExactKeys(value.sharedRecord, ["visibility", "authority", "canEitherMemberEnd"])
    && value.sharedRecord.visibility === "both_members"
    && value.sharedRecord.authority === "equal"
    && value.sharedRecord.canEitherMemberEnd === true;
}

export function isChallengeSnapshot(value: unknown): value is ChallengeSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id", "invitationId", "timeZone", "startDate", "deadlineDate", "problemSetVersionId", "status", "createdAt", "members",
  ]) && !hasExactKeys(value, [
    "id", "invitationId", "timeZone", "startDate", "deadlineDate", "problemSetVersionId", "status", "createdAt", "members", "terminalActorId", "terminalAt",
  ]) && !hasExactKeys(value, [
    "id", "invitationId", "timeZone", "startDate", "deadlineDate", "problemSetVersionId", "status", "createdAt", "members", "progress",
  ]) && !hasExactKeys(value, [
    "id", "invitationId", "timeZone", "startDate", "deadlineDate", "problemSetVersionId", "status", "createdAt", "members", "terminalActorId", "terminalAt", "progress",
  ])) return false;
  if (!isString(value.id) || !isString(value.invitationId) || !isString(value.timeZone)
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.startDate))
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.deadlineDate))
    || !isString(value.problemSetVersionId) || !["scheduled", "active", "canceled"].includes(String(value.status)) || !isString(value.createdAt)
    || (value.terminalActorId !== undefined && value.terminalActorId !== null && !isString(value.terminalActorId))
    || (value.terminalAt !== undefined && value.terminalAt !== null && !isString(value.terminalAt))
    || !Array.isArray(value.members) || value.members.length !== 2) return false;
  return value.members.every((member) => isRecord(member)
    && hasExactKeys(member, ["memberId", "email", "displayName", "authority"])
    && isString(member.memberId) && isString(member.email) && isString(member.displayName)
    && member.authority === "equal")
    && (!('progress' in value) || isActiveProgress(value.progress));
}

export function parseInvitationDetails(value: unknown): InvitationDetailsRecord {
  if (!isRecord(value)
    || !hasExactKeys(value, ["invitation", "problemSetVersion", "partner", "sharedRecord"])
    || !isInvitation(value.invitation) || !isInvitationDetails({
    problemSetVersion: value.problemSetVersion,
    partner: value.partner,
    sharedRecord: value.sharedRecord,
  })) {
    throw new Error("The backend returned invalid Invitation details.");
  }
  return value as InvitationDetailsRecord;
}

export function parseChallengeSnapshot(value: unknown): ChallengeSnapshot {
  if (!isChallengeSnapshot(value)) throw new Error("The backend returned an invalid Scheduled Challenge.");
  return value;
}

function isChallengeActions(value: unknown): value is readonly ChallengeAction[] {
  return Array.isArray(value) && value.every((action) => action === "cancel" || action === "solve");
}

function isActiveProgress(value: unknown): value is ActiveChallengeProgress {
  if (!isRecord(value) || !hasExactKeys(value, [
    "problemSetVersionId", "day", "durationDays", "expectedProgress", "previousExpectedProgress",
    "earlierExpectedProgress", "pairProgress", "petCondition", "currentEvolutionStage",
    "highestEvolutionStage", "members",
  ])) return false;
  if (!isString(value.problemSetVersionId)
    || typeof value.day !== "number" || !Number.isInteger(value.day)
    || typeof value.durationDays !== "number" || !Number.isInteger(value.durationDays) || value.durationDays < 1
    || value.day < 0 || value.day > value.durationDays + 1
    || typeof value.expectedProgress !== "number" || !Number.isInteger(value.expectedProgress) || value.expectedProgress < 0 || value.expectedProgress > 150
    || typeof value.previousExpectedProgress !== "number" || !Number.isInteger(value.previousExpectedProgress) || value.previousExpectedProgress < 0 || value.previousExpectedProgress > 150
    || typeof value.earlierExpectedProgress !== "number" || !Number.isInteger(value.earlierExpectedProgress) || value.earlierExpectedProgress < 0 || value.earlierExpectedProgress > 150
    || typeof value.pairProgress !== "number" || value.pairProgress < 0 || value.pairProgress > 150
    || !["healthy", "hungry", "sad", "deteriorated"].includes(String(value.petCondition))
    || ![1, 2, 3, 4].includes(Number(value.currentEvolutionStage))
    || ![1, 2, 3, 4].includes(Number(value.highestEvolutionStage))
    || !Array.isArray(value.members) || value.members.length !== 2) return false;
  return value.members.every((member) => {
    if (!isRecord(member) || !hasExactKeys(member, [
      "memberId", "email", "displayName", "authority", "creditedTotal", "paceStatus", "paceGap",
    ])) return false;
    if (!isString(member.memberId) || !isString(member.email) || !isString(member.displayName)
      || member.authority !== "equal" || typeof member.creditedTotal !== "number" || !Number.isInteger(member.creditedTotal)
      || member.creditedTotal < 0 || member.creditedTotal > 150 || !["behind", "on_pace_today", "todays_pace_met"].includes(String(member.paceStatus))) return false;
    const paceGap = member.paceGap;
    return isRecord(paceGap)
      && hasExactKeys(paceGap, [
        "previousTarget", "currentTarget", "gapToPreviousTarget", "amountNeededToday", "amountAhead", "copy",
      ])
      && ["previousTarget", "currentTarget", "gapToPreviousTarget", "amountNeededToday", "amountAhead"]
        .every((key) => typeof paceGap[key] === "number" && Number.isInteger(paceGap[key] as number))
      && isString(paceGap.copy);
  });
}

export function isPendingCommand(value: unknown): value is PendingCommand {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "kind",
    "idempotencyKey",
    "memberId",
    "memberEmail",
    "intent",
    "requestedAt",
  ])) return false;
  if (value.version !== TRANSACTION_COMMAND_VERSION
    || !["update_display_name", "create_invitation", "accept_invitation", "revoke_invitation", "decline_invitation", "cancel_challenge", "create_solve"].includes(String(value.kind))
    || !isString(value.idempotencyKey) || !isString(value.memberId)
    || !isString(value.memberEmail) || !isString(value.requestedAt)) return false;
  if (!isRecord(value.intent)) return false;
  if (value.kind === "update_display_name") {
    return hasExactKeys(value.intent, ["displayName"])
      && typeof value.intent.displayName === "string";
  }
  if (value.kind === "create_invitation") return hasExactKeys(value.intent, ["invitedEmail", "timeZone", "startDate", "deadlineDate", "problemSetVersionId"])
    && typeof value.intent.invitedEmail === "string"
    && typeof value.intent.timeZone === "string"
    && typeof value.intent.startDate === "string"
    && typeof value.intent.deadlineDate === "string"
    && typeof value.intent.problemSetVersionId === "string";
  if (value.kind === "cancel_challenge") return hasExactKeys(value.intent, ["challengeId"])
    && typeof value.intent.challengeId === "string";
  if (value.kind === "create_solve") return hasExactKeys(value.intent, ["challengeId", "problemId", "affirmed"])
    && typeof value.intent.challengeId === "string"
    && typeof value.intent.problemId === "string"
    && value.intent.affirmed === true;
  return hasExactKeys(value.intent, ["invitationId"])
    && typeof value.intent.invitationId === "string";
}

export function isCommandOutcome(value: unknown): value is CommandOutcome {
  if (!isRecord(value) || typeof value.status !== "string"
    || !["update_display_name", "create_invitation", "accept_invitation", "revoke_invitation", "decline_invitation", "cancel_challenge", "create_solve"].includes(String(value.kind))) return false;
  if (value.status === "applied") {
    return hasExactKeys(value, ["status", "kind", "idempotencyKey"]) && isString(value.idempotencyKey);
  }
  if (value.status === "uncertain") {
    return hasExactKeys(value, ["status", "kind", "idempotencyKey", "message"])
      && isString(value.idempotencyKey)
      && value.message === "Checking whether this completed.";
  }
  return value.status === "rejected"
    && hasExactKeys(value, ["status", "kind", "code", "message"])
    && (value.code === "unauthorized" || value.code === "validation" || value.code === "rate_limited")
    && isString(value.message);
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
    && !hasExactKeys(value, [...keys, "account"])
    && !hasExactKeys(value, [...keys, "pendingCommand"])
    && !hasExactKeys(value, [...keys, "email", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "account", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "invitation"])
    && !hasExactKeys(value, [...keys, "invitation", "details"])
    && !hasExactKeys(value, [...keys, "invitation", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "invitation", "details", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "invitation", "role"])
    && !hasExactKeys(value, [...keys, "invitation", "actions"])
    && !hasExactKeys(value, [...keys, "invitation", "role", "actions"])
    && !hasExactKeys(value, [...keys, "invitation", "role", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "invitation", "actions", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "invitation", "role", "actions", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "invitation", "details", "role", "actions"])
    && !hasExactKeys(value, [...keys, "invitation", "details", "role", "actions", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "challenge"])
    && !hasExactKeys(value, [...keys, "challenge", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "challenge", "actions"])
    && !hasExactKeys(value, [...keys, "challenge", "actions", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "challenge", "progress"])
    && !hasExactKeys(value, [...keys, "challenge", "progress", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "challenge", "progress", "actions"])
    && !hasExactKeys(value, [...keys, "challenge", "progress", "actions", "pendingCommand"])
    && !hasExactKeys(value, [...keys, "actions"])
    && !hasExactKeys(value, [...keys, "actions", "pendingCommand"])) return false;
  if (value.contractVersion !== PROTOCOL_VERSION || !isString(value.authoritativeServerTime) || !isWorkerEvidence(value.worker)) {
    return false;
  }
  if (!isRecord(value.freshness) || !hasExactKeys(value.freshness, ["revision", "fetchedAt"])
    || !isString(value.freshness.revision) || !isString(value.freshness.fetchedAt)) return false;
  if (!isRecord(value.compatibility) || !hasExactKeys(value.compatibility, ["minimumClientVersion"])
    || !isString(value.compatibility.minimumClientVersion)) return false;
  if (!isRecord(value.backend) || !hasExactKeys(value.backend, ["status", "schemaVersion"])
    || value.backend.status !== "reachable" || typeof value.backend.schemaVersion !== "number") return false;
  if ("pendingCommand" in value && value.pendingCommand !== null && !isPendingCommand(value.pendingCommand)) return false;
  const hasOptionalPending = (required: readonly string[]) =>
    hasExactKeys(value, required) || hasExactKeys(value, [...required, "pendingCommand"]);
  const hasOptionalPendingAndActions = (required: readonly string[]) =>
    hasOptionalPending(required)
    || hasExactKeys(value, [...required, "actions"])
    || hasExactKeys(value, [...required, "actions", "pendingCommand"]);
  if (value.kind === "setup_required") return hasOptionalPending([...keys, "email"]) && isString(value.email);
  if (value.kind === "account") return hasOptionalPending([...keys, "account"]) && isMemberAccount(value.account);
  if (value.kind === "invitation") {
    const invitationKeys = [
      [...keys, "invitation"],
      [...keys, "invitation", "details"],
      [...keys, "invitation", "role"],
      [...keys, "invitation", "actions"],
      [...keys, "invitation", "role", "actions"],
      [...keys, "invitation", "details", "role", "actions"],
    ];
    const hasInvitationShape = invitationKeys.some((required) => hasOptionalPending(required));
    return hasInvitationShape && isInvitation(value.invitation)
      && (!('details' in value) || isInvitationDetails(value.details))
      && (!('role' in value) || value.role === "inviter" || value.role === "invitee")
      && (!('actions' in value) || (Array.isArray(value.actions)
        && value.actions.every((action) => ["accept", "decline", "revoke"].includes(String(action)))));
  }
  if (value.kind === "scheduled") {
    return hasOptionalPendingAndActions([...keys, "challenge"])
      && isChallengeSnapshot(value.challenge)
      && (!('actions' in value) || isChallengeActions(value.actions));
  }
  if (value.kind === "active") {
    const activeShape = hasOptionalPending([...keys, "challenge", "progress"])
      || hasExactKeys(value, [...keys, "challenge", "progress", "actions"])
      || hasExactKeys(value, [...keys, "challenge", "progress", "pendingCommand"])
      || hasExactKeys(value, [...keys, "challenge", "progress", "actions", "pendingCommand"]);
    return activeShape
      && isChallengeSnapshot(value.challenge)
      && isActiveProgress(value.progress)
      && (!('actions' in value) || isChallengeActions(value.actions));
  }
  if (value.kind === "terminal") {
    return (hasOptionalPendingAndActions(keys) || hasOptionalPendingAndActions([...keys, "challenge"]))
      && (!('challenge' in value) || isChallengeSnapshot(value.challenge))
      && (!('actions' in value) || isChallengeActions(value.actions));
  }
  return ["signed_out", "invitation", "scheduled", "active", "terminal"].includes(String(value.kind))
    && hasOptionalPending(keys);
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
  if (value.type === "update_display_name") {
    return hasExactKeys(value, ["version", "type", "displayName"]) && typeof value.displayName === "string";
  }
  if (value.type === "create_invitation") {
    return hasExactKeys(value, ["version", "type", "invitedEmail", "timeZone", "startDate", "deadlineDate"])
      && typeof value.invitedEmail === "string"
      && typeof value.timeZone === "string"
      && typeof value.startDate === "string"
      && typeof value.deadlineDate === "string";
  }
  if (value.type === "accept_invitation" || value.type === "revoke_invitation" || value.type === "decline_invitation") {
    return hasExactKeys(value, ["version", "type", "invitationId"]) && isString(value.invitationId);
  }
  if (value.type === "cancel_challenge") {
    return hasExactKeys(value, ["version", "type", "challengeId"]) && isString(value.challengeId);
  }
  if (value.type === "credit_solve") {
    return hasExactKeys(value, ["version", "type", "challengeId", "problemId", "affirmed"])
      && isString(value.challengeId) && isString(value.problemId) && value.affirmed === true;
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
    const hasCommand = value.command !== undefined;
    if (!hasSnapshot && !hasAuth && !hasCommand) return false;
    if (hasSnapshot && !isSnapshot(value.snapshot)) return false;
    if (hasAuth && !isSignInState(value.auth)) return false;
    if ("command" in value && !isCommandOutcome(value.command)) return false;
    const expectedKeys = hasSnapshot && hasAuth
      ? ["ok", "snapshot", "auth"]
      : hasSnapshot
        ? ["ok", "snapshot"]
        : hasAuth
          ? ["ok", "auth"]
          : ["ok", "command"];
    const expectedWithCommand = hasSnapshot ? [...expectedKeys, "command"] : expectedKeys;
    return hasExactKeys(value, expectedKeys) || hasExactKeys(value, expectedWithCommand);
  }
  if (!hasExactKeys(value, ["ok", "error"]) || !isRecord(value.error)) return false;
  if (!hasExactKeys(value.error, ["code", "message"]) && !hasExactKeys(value.error, ["code", "message", "diagnosticId"])) return false;
  return ["bad_request", "connection_unavailable", "incompatible_client", "internal", "unauthorized"].includes(String(value.error.code))
    && isString(value.error.message)
    && (value.error.diagnosticId === undefined || isString(value.error.diagnosticId));
}
