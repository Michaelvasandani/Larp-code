import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  PROTOCOL_VERSION,
  isTerminalChallengeStatus,
  createUncertainCommandOutcome,
  isPopupRequest,
  type AppSnapshot,
  type ChallengeSnapshot,
  type PendingCommand,
  type PopupRequest,
  type PopupResponse,
  type ProtocolError,
  type WorkerEvidence,
  type WorkerEvent,
} from "../shared/protocol";
import { PINNED_PROBLEM_SET_VERSION } from "../catalog/problem-set";
import {
  createAuthSessionAdapter,
  type AuthSession,
  type AuthApi,
  type MemberStorage,
} from "./auth-session";
import {
  createMemberAccountAdapter,
  parseMemberAccount,
  type MemberAccountRpc,
} from "./member-account";
import {
  createDisplayNameCommandAdapter,
  type DisplayNameCommandRpc,
} from "./command-recovery";
import {
  createInvitationCommandAdapter,
  createInvitationTerminalCommandAdapter,
  parseInvitation,
  type CreateInvitationRpc,
  type InvitationTerminalRpc,
  type InvitationTerminalRpcInput,
  type InvitationRecord,
} from "./invitation";
import {
  createAcceptInvitationCommandAdapter,
  parseChallenge,
  parseInvitationDetails,
} from "./acceptance";
import {
  createChallengeLifecycleCommandAdapter,
  parseChallenge as parseLifecycleChallenge,
  projectChallenge,
  type ChallengeLifecycleRpc,
} from "./challenge";
import {
  createSolveCommandAdapter,
  createSolveCorrectionCommandAdapter,
  parseSolve,
  parseSolveCorrection,
  type SolveRpc,
  type SolveCorrectionRpc,
} from "./solve";
import { createDebouncedSnapshotInvalidation } from "./realtime";

const BOOT_COUNT_KEY = "larp-code.workerBootCount";
const SESSION_STORAGE_PREFIX = "larp-code.supabase.";
const LAST_INVITATION_ID_KEY = "invitation.lastId";
const LAST_CHALLENGE_ID_KEY = "challenge.lastId";

type FoundationHealth = {
  service: "larp-code";
  schemaVersion: number;
  serverTime: string;
};

function createPrefixedStorage(prefix: string) {
  const storageKey = (key: string) => `${prefix}${key}`;
  return {
    async getItem(key: string): Promise<string | null> {
      const values = await chrome.storage.local.get(storageKey(key));
      const value = values[storageKey(key)];
      return typeof value === "string" ? value : null;
    },
    async setItem(key: string, value: string): Promise<void> {
      await chrome.storage.local.set({ [storageKey(key)]: value });
    },
    async removeItem(key: string): Promise<void> {
      await chrome.storage.local.remove(storageKey(key));
    },
    async get(key: string): Promise<unknown> {
      const values = await chrome.storage.local.get(storageKey(key));
      return values[storageKey(key)] ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage.local.set({ [storageKey(key)]: value });
    },
    async remove(key: string): Promise<void> {
      await chrome.storage.local.remove(storageKey(key));
    },
    async clear(): Promise<void> {
      const values = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(
        Object.keys(values).filter((key) => key.startsWith(prefix)),
      );
    },
  };
}

const extensionStorage = createPrefixedStorage(SESSION_STORAGE_PREFIX);
const memberStorage: MemberStorage = extensionStorage;

const client: SupabaseClient = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
  auth: {
    // The adapter owns the single explicit refresh attempt for each snapshot.
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: true,
    storage: extensionStorage,
  },
});

const authSessionAdapter = createAuthSessionAdapter({
  auth: client.auth as unknown as AuthApi,
  storage: memberStorage,
});
const memberAccountRpc: MemberAccountRpc = {
  async getMemberAccount() {
    const response = await client.rpc("get_member_account_v1");
    const data: unknown = response.data;
    const error: unknown = response.error;
    if (error) throw error;
    return data === null ? null : parseMemberAccount(data);
  },
  async createMemberAccount(input) {
    const { data, error } = await client.rpc("create_member_account_v1", {
      p_display_name: input.displayName,
      p_adult_confirmed: input.adultConfirmed,
      p_consent_accepted: input.consentAccepted,
      p_consent_version: input.consentVersion,
    });
    if (error) throw error;
    return parseMemberAccount(data);
  },
};
const displayNameCommandRpc: DisplayNameCommandRpc = {
  async updateDisplayName(input) {
    const { data, error } = await client.rpc("update_member_display_name_v1", {
      p_idempotency_key: input.idempotencyKey,
      p_command_version: input.commandVersion,
      p_command_kind: input.commandKind,
      p_member_id: input.memberId,
      p_member_email: input.memberEmail,
      p_display_name: input.displayName,
    });
    if (error) throw error;
    return parseMemberAccount(data);
  },
};
const invitationCommandRpc: CreateInvitationRpc = {
  async createInvitation(input) {
    const { data, error } = await client.rpc("create_invitation_v1", {
      p_idempotency_key: input.idempotencyKey,
      p_command_version: input.commandVersion,
      p_command_kind: input.commandKind,
      p_member_id: input.memberId,
      p_member_email: input.memberEmail,
      p_invited_email: input.terms.invitedEmail,
      p_challenge_time_zone: input.terms.timeZone,
      p_start_date: input.terms.startDate,
      p_deadline_date: input.terms.deadlineDate,
      p_problem_set_version_id: input.problemSetVersionId,
    });
    if (error) throw error;
    return parseInvitation(data);
  },
  async dispatchInvitationNotice(invitationId) {
    const { error } = await client.functions.invoke("send-invitation-notice", {
      body: { invitationId },
    });
    if (error) throw error;
  },
  async getPendingInvitation() {
    const { data, error } = await client.rpc("get_pending_invitation_for_member_v1");
    if (error) throw error;
    return data === null ? null : parseInvitation(data);
  },
  async getPendingInvitationDetails() {
    const { data, error } = await client.rpc("get_pending_invitation_details_for_member_v1");
    if (error) throw error;
    return data === null ? null : parseInvitationDetails(data);
  },
};

async function callInvitationTerminalRpc(
  functionName: "revoke_invitation_v1" | "decline_invitation_v1",
  input: InvitationTerminalRpcInput,
): Promise<ReturnType<typeof parseInvitation>> {
  const { data, error } = await client.rpc(functionName, {
    p_idempotency_key: input.idempotencyKey,
    p_command_version: input.commandVersion,
    p_command_kind: input.commandKind,
    p_member_id: input.memberId,
    p_member_email: input.memberEmail,
    p_invitation_id: input.invitationId,
  });
  if (error) throw error;
  return parseInvitation(data);
}

const invitationTerminalRpc: InvitationTerminalRpc = {
  async revokeInvitation(input) {
    return callInvitationTerminalRpc("revoke_invitation_v1", input);
  },
  async declineInvitation(input) {
    return callInvitationTerminalRpc("decline_invitation_v1", input);
  },
  async getInvitation(invitationId) {
    const { data, error } = await client.rpc("get_invitation_v1", { p_invitation_id: invitationId });
    if (error) throw error;
    return data === null ? null : parseInvitation(data);
  },
  async getPendingOutgoingInvitation() {
    const { data, error } = await client.rpc("get_pending_outgoing_invitation_v1");
    if (error) throw error;
    return data === null ? null : parseInvitation(data);
  },
};
const challengeLifecycleRpc: ChallengeLifecycleRpc = {
  async sendChallengeLifecycleCommand(input) {
    const { data, error } = await client.rpc(input.commandKind === "cancel_challenge" ? "cancel_challenge_v1" : "abandon_challenge_v1", {
      p_idempotency_key: input.idempotencyKey,
      p_command_version: input.commandVersion,
      p_command_kind: input.commandKind,
      p_member_id: input.memberId,
      p_member_email: input.memberEmail,
      p_challenge_id: input.challengeId,
    });
    if (error) throw error;
    return parseLifecycleChallenge(data);
  },
  async getCommittedChallenge() {
    const { data, error } = await client.rpc("get_committed_challenge_for_member_v1");
    if (error) throw error;
    return data === null ? null : parseLifecycleChallenge(data);
  },
  async getChallenge(challengeId) {
    const { data, error } = await client.rpc("get_challenge_v1", { p_challenge_id: challengeId });
    if (error) throw error;
    return data === null ? null : parseLifecycleChallenge(data);
  },
  async getLatestCanceledChallenge() {
    const { data, error } = await client.rpc("get_latest_terminal_challenge_for_member_v1");
    if (error) throw error;
    return data === null ? null : parseLifecycleChallenge(data);
  },
};
const solveRpc: SolveRpc = {
  async createSolve(input) {
    const { data, error } = await client.rpc("create_solve_v1", {
      p_idempotency_key: input.idempotencyKey,
      p_command_version: input.commandVersion,
      p_command_kind: input.commandKind,
      p_member_id: input.memberId,
      p_member_email: input.memberEmail,
      p_challenge_id: input.challengeId,
      p_problem_id: input.problemId,
      p_affirmed: input.affirmed,
    });
    if (error) throw error;
    return parseSolve(data);
  },
};
const solveCorrectionRpc: SolveCorrectionRpc = {
  async correctSolve(input) {
    const { data, error } = await client.rpc("correct_solve_v1", {
      p_idempotency_key: input.idempotencyKey,
      p_command_version: input.commandVersion,
      p_command_kind: input.commandKind,
      p_member_id: input.memberId,
      p_member_email: input.memberEmail,
      p_challenge_id: input.challengeId,
      p_solve_id: input.solveId,
      p_category: input.category,
      p_reason: input.reason,
      p_resulting_credit_status: input.resultingCreditStatus,
    });
    if (error) throw error;
    return parseSolveCorrection(data);
  },
};
const displayNameCommands = createDisplayNameCommandAdapter({
  rpc: displayNameCommandRpc,
  storage: memberStorage,
});
const invitationCommands = createInvitationCommandAdapter({
  rpc: invitationCommandRpc,
  storage: memberStorage,
});
const acceptanceCommands = createAcceptInvitationCommandAdapter({
  storage: memberStorage,
  rpc: {
    async acceptInvitation(input) {
      const { data, error } = await client.rpc("accept_invitation_v1", {
        p_idempotency_key: input.idempotencyKey,
        p_command_version: input.commandVersion,
        p_command_kind: input.commandKind,
        p_member_id: input.memberId,
        p_member_email: input.memberEmail,
        p_invitation_id: input.invitationId,
      });
      if (error) throw error;
      return parseChallenge(data);
    },
  },
});
const invitationTerminalCommands = createInvitationTerminalCommandAdapter({
  rpc: invitationTerminalRpc,
  storage: memberStorage,
});
const challengeCommands = createChallengeLifecycleCommandAdapter({
  rpc: challengeLifecycleRpc,
  storage: memberStorage,
});
const solveCommands = createSolveCommandAdapter({
  rpc: solveRpc,
  storage: memberStorage,
});
const solveCorrectionCommands = createSolveCorrectionCommandAdapter({
  rpc: solveCorrectionRpc,
  storage: memberStorage,
});
const bootId = crypto.randomUUID();
const initialSessionStatePromise = authSessionAdapter.restoreSession();
let pendingSnapshotSession: typeof initialSessionStatePromise | undefined = initialSessionStatePromise;
const workerEvidencePromise = initializeWorkerEvidence();
const popupPorts = new Set<chrome.runtime.Port>();
let realtimeChannel: ReturnType<typeof client.channel> | null = null;

function broadcastWorkerEvent(event: Extract<WorkerEvent, { version: typeof PROTOCOL_VERSION }>): void {
  for (const port of popupPorts) {
    try { port.postMessage(event); } catch { /* Popup closed between invalidation and delivery. */ }
  }
}

const realtimeInvalidation = createDebouncedSnapshotInvalidation({
  refetch: () => getAppSnapshot(),
  // Realtime is an invalidation signal. The payload is deliberately never
  // rendered as progress or Pet state by the popup.
  onInvalidated: () => broadcastWorkerEvent({ version: PROTOCOL_VERSION, type: "snapshot_invalidated" }),
});

function startRealtime(): void {
  if (realtimeChannel) return;
  broadcastWorkerEvent({ version: PROTOCOL_VERSION, type: "realtime_status", status: "connecting" });
  realtimeChannel = client.channel("larp-code-active-challenge")
    .on("postgres_changes", { event: "*", schema: "public", table: "solves" }, realtimeInvalidation.invalidate)
    .on("postgres_changes", { event: "*", schema: "public", table: "solve_corrections" }, realtimeInvalidation.invalidate)
    .on("postgres_changes", { event: "*", schema: "public", table: "challenges" }, realtimeInvalidation.invalidate)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") realtimeInvalidation.invalidate();
      const mapped = status === "SUBSCRIBED" ? "subscribed" : status === "CHANNEL_ERROR" ? "error" : status === "CLOSED" ? "closed" : "connecting";
      broadcastWorkerEvent({ version: PROTOCOL_VERSION, type: "realtime_status", status: mapped });
    });
}

function stopRealtime(): void {
  realtimeInvalidation.dispose();
  if (!realtimeChannel) return;
  void client.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

async function initializeWorkerEvidence(): Promise<WorkerEvidence> {
  const stored = await chrome.storage.local.get(BOOT_COUNT_KEY);
  const previous = typeof stored[BOOT_COUNT_KEY] === "number" ? stored[BOOT_COUNT_KEY] : 0;
  const bootCount = previous + 1;
  await chrome.storage.local.set({ [BOOT_COUNT_KEY]: bootCount });
  const restored = await initialSessionStatePromise;
  return {
    bootId,
    bootCount,
    sessionRestoredFromStorage: restored.status === "authenticated",
  };
}

function isFoundationHealth(value: unknown): value is FoundationHealth {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  return health.service === "larp-code"
    && typeof health.schemaVersion === "number"
    && Number.isInteger(health.schemaVersion)
    && typeof health.serverTime === "string"
    && !Number.isNaN(Date.parse(health.serverTime));
}

async function readFoundationHealth(): Promise<FoundationHealth> {
  let data: unknown;
  let error: unknown;
  try {
    const response = await client.rpc("foundation_health_v1");
    data = response.data;
    error = response.error;
  } catch {
    throw new Error("The backend connection is unavailable.");
  }
  if (error) throw new Error("The backend connection is unavailable.");
  if (!isFoundationHealth(data)) throw new Error("The backend returned an invalid foundation health response.");
  return data;
}

function snapshotMetadata(health: FoundationHealth, worker: WorkerEvidence, pendingCommand: Awaited<ReturnType<typeof displayNameCommands.readPending>>) {
  const fetchedAt = new Date().toISOString();
  return {
    contractVersion: PROTOCOL_VERSION,
    authoritativeServerTime: health.serverTime,
    freshness: {
      revision: `${health.schemaVersion}:${health.serverTime}`,
      fetchedAt,
    },
    compatibility: { minimumClientVersion: __CLIENT_VERSION__ },
    backend: { status: "reachable" as const, schemaVersion: health.schemaVersion },
    worker,
    pendingCommand,
  };
}

async function buildChallengeSnapshot(challenge: ChallengeSnapshot): Promise<AppSnapshot> {
  const health = await readFoundationHealth();
  const worker = await workerEvidencePromise;
  const projection = projectChallenge(challenge, health.serverTime);
  const metadata = snapshotMetadata(health, worker, null);
  if (projection.status === "active") {
    if (!projection.challenge.progress) throw new Error("The backend returned an Active Challenge without progress.");
    return {
      ...metadata,
      kind: "active",
      challenge: projection.challenge,
      progress: projection.challenge.progress,
      actions: projection.actions,
    };
  }
  if (projection.status === "scheduled") {
    return { ...metadata, kind: "scheduled", challenge: projection.challenge, actions: projection.actions };
  }
  return { ...metadata, kind: "terminal", challenge: projection.challenge, actions: projection.actions };
}

type AuthenticatedMember = {
  session: AuthSession;
  identity: { memberId: string; memberEmail: string };
};

async function withAuthenticatedMember<T>(operation: (member: AuthenticatedMember) => Promise<T>): Promise<T> {
  const sessionState = await authSessionAdapter.restoreSession();
  if (sessionState.status === "service_unavailable") {
    throw new Error("The authentication connection is unavailable.");
  }
  if (sessionState.status !== "authenticated") {
    await displayNameCommands.clearPending();
    throw new Error("Authentication is required.");
  }
  const memberEmail = sessionState.session.user.email;
  if (!memberEmail) throw new Error("A verified email is required.");
  return operation({
    session: sessionState.session,
    identity: { memberId: sessionState.session.user.id, memberEmail },
  });
}

type CommandResult =
  | { kind: "update_display_name"; result: Awaited<ReturnType<typeof displayNameCommands.updateDisplayName>> }
  | { kind: "create_invitation"; result: Awaited<ReturnType<typeof invitationCommands.createInvitation>> }
  | { kind: "accept_invitation"; result: Awaited<ReturnType<typeof acceptanceCommands.acceptInvitation>> }
  | { kind: "revoke_invitation" | "decline_invitation"; result: Awaited<ReturnType<typeof invitationTerminalCommands.revokeInvitation>> }
  | { kind: "cancel_challenge" | "abandon_challenge"; result: Awaited<ReturnType<typeof challengeCommands.cancelChallenge>> }
  | { kind: "create_solve"; result: Awaited<ReturnType<typeof solveCommands.createSolve>> }
  | { kind: "correct_solve"; result: Awaited<ReturnType<typeof solveCorrectionCommands.correctSolve>> };
type AppliedInvitationCommand = Extract<CommandResult, { kind: "create_invitation" | "revoke_invitation" | "decline_invitation" }>;
type AppliedInvitationResult = Extract<AppliedInvitationCommand["result"], { status: "applied" }>;
type AppliedAcceptanceResult = Extract<Extract<CommandResult, { kind: "accept_invitation" }>['result'], { status: "applied" }>;
type AppliedChallengeResult = Extract<Extract<CommandResult, { kind: "cancel_challenge" | "abandon_challenge" }>['result'], { status: "applied" }>;
type AppliedSolveResult = Extract<Extract<CommandResult, { kind: "create_solve" }>['result'], { status: "applied" }>;
type AppliedCorrectionResult = Extract<Extract<CommandResult, { kind: "correct_solve" }>['result'], { status: "applied" }>;
function invitationSnapshot(
  health: FoundationHealth,
  worker: WorkerEvidence,
  invitation: InvitationRecord,
  role: "inviter" | "invitee",
  pendingCommand: PendingCommand | null = null,
): AppSnapshot {
  return {
    ...snapshotMetadata(health, worker, pendingCommand),
    kind: "invitation",
    invitation,
    role,
    actions: invitation.status === "pending"
      ? role === "inviter" ? ["revoke"] : ["accept", "decline"]
      : [],
  };
}

async function rememberInvitation(invitationId: string): Promise<void> {
  await extensionStorage.set(LAST_INVITATION_ID_KEY, invitationId);
}

async function respondToCommand(
  command: CommandResult,
  buildAppliedSnapshot?: (result: AppliedInvitationResult | AppliedAcceptanceResult | AppliedChallengeResult | AppliedSolveResult | AppliedCorrectionResult) => Promise<AppSnapshot>,
): Promise<PopupResponse> {
  let snapshot: AppSnapshot;
  try {
    snapshot = await getAppSnapshot(false);
  } catch (error) {
    if (command.result.status === "uncertain") {
      return {
        ok: true,
        command: createUncertainCommandOutcome(command.result.idempotencyKey, command.kind),
      };
    }
    throw error;
  }
  if (command.result.status === "uncertain") {
    return {
      ok: true,
      snapshot,
      command: createUncertainCommandOutcome(command.result.idempotencyKey, command.kind),
    };
  }
  if (command.result.status === "rejected") {
    return {
      ok: true,
      snapshot,
      command: { status: "rejected", kind: command.kind, code: command.result.code, message: command.result.message },
    };
  }
  if (command.kind === "create_invitation" && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(command.result as AppliedInvitationResult);
  }
  if (command.kind === "accept_invitation" && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(command.result as AppliedAcceptanceResult);
  }
  if ((command.kind === "revoke_invitation" || command.kind === "decline_invitation") && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(
      command.result as AppliedInvitationResult,
    );
  }
  if (command.kind === "cancel_challenge" && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(command.result as AppliedChallengeResult);
  }
  if (command.kind === "abandon_challenge" && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(command.result as AppliedChallengeResult);
  }
  if (command.kind === "create_solve" && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(command.result as AppliedSolveResult);
  }
  if (command.kind === "correct_solve" && buildAppliedSnapshot) {
    snapshot = await buildAppliedSnapshot(command.result as AppliedCorrectionResult);
  }
  return {
    ok: true,
    snapshot,
    command: { status: "applied", kind: command.kind, idempotencyKey: command.result.idempotencyKey },
  };
}

async function getAppSnapshot(reconcilePending = true): Promise<AppSnapshot> {
  const sessionStatePromise = pendingSnapshotSession ?? authSessionAdapter.restoreSession();
  pendingSnapshotSession = undefined;
  const [health, worker, sessionState] = await Promise.all([
    readFoundationHealth(),
    workerEvidencePromise,
    sessionStatePromise,
  ]);
  if (sessionState.status === "service_unavailable") throw new Error("The authentication connection is unavailable.");
  if (sessionState.status !== "authenticated") {
    await displayNameCommands.clearPending();
    return { ...snapshotMetadata(health, worker, null), kind: "signed_out" };
  }

  const memberAccount = createMemberAccountAdapter({ rpc: memberAccountRpc, session: sessionState.session });
  const identity = {
    memberId: sessionState.session.user.id,
    email: sessionState.session.user.email ?? "",
  };
  if (reconcilePending) {
    await displayNameCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
    await invitationCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
    await acceptanceCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
    await invitationTerminalCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
    await challengeCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
    await solveCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
    await solveCorrectionCommands.recover({ memberId: identity.memberId, memberEmail: identity.email });
  }
  const account = await memberAccount.getMemberAccount();
  if (!account) {
    await displayNameCommands.clearPending();
    const email = sessionState.session.user.email;
    if (!email) throw new Error("The authenticated session has no verified email.");
    return { ...snapshotMetadata(health, worker, null), kind: "setup_required", email };
  }
  const pendingCommand = await displayNameCommands.readPending()
    ?? await invitationCommands.readPending()
    ?? await acceptanceCommands.readPending()
    ?? await invitationTerminalCommands.readPending()
    ?? await challengeCommands.readPending()
    ?? await solveCommands.readPending()
    ?? await solveCorrectionCommands.readPending();
  const incomingDetails = await invitationCommandRpc.getPendingInvitationDetails?.();
  if (incomingDetails) {
    const { invitation, ...details } = incomingDetails;
    await rememberInvitation(invitation.id);
    return {
      ...snapshotMetadata(health, worker, pendingCommand),
      kind: "invitation",
      invitation,
      details,
      role: "invitee",
      actions: invitation.status === "pending" ? ["accept", "decline"] : [],
    };
  }
  const incomingInvitation = await invitationCommandRpc.getPendingInvitation?.();
  if (incomingInvitation) {
    await rememberInvitation(incomingInvitation.id);
    return invitationSnapshot(health, worker, incomingInvitation, "invitee", pendingCommand);
  }
  const outgoingInvitation = await invitationTerminalRpc.getPendingOutgoingInvitation?.();
  if (outgoingInvitation) {
    await rememberInvitation(outgoingInvitation.id);
    return invitationSnapshot(health, worker, outgoingInvitation, "inviter", pendingCommand);
  }
  const rememberedInvitationId = await extensionStorage.get(LAST_INVITATION_ID_KEY);
  if (typeof rememberedInvitationId === "string") {
    try {
      const rememberedInvitation = await invitationTerminalRpc.getInvitation?.(rememberedInvitationId);
      if (rememberedInvitation && ["revoked", "declined", "expired"].includes(rememberedInvitation.status)) {
        return invitationSnapshot(
          health,
          worker,
          rememberedInvitation,
          rememberedInvitation.inviterId === identity.memberId ? "inviter" : "invitee",
          pendingCommand,
        );
      }
    } catch {
      // A changed browser identity or a removed Invitation must not leak or
      // block the current Member's account Snapshot.
    }
    await extensionStorage.remove(LAST_INVITATION_ID_KEY);
  }
  const rememberedChallengeId = await extensionStorage.get(LAST_CHALLENGE_ID_KEY);
  if (typeof rememberedChallengeId === "string") {
    try {
      const rememberedChallenge = await challengeLifecycleRpc.getChallenge?.(rememberedChallengeId);
      if (rememberedChallenge && isTerminalChallengeStatus(rememberedChallenge.status)) {
        return buildChallengeSnapshot(rememberedChallenge);
      }
    } catch {
      // A changed browser identity or a removed Challenge must not leak or
      // block the current Member's account Snapshot.
    }
    await extensionStorage.remove(LAST_CHALLENGE_ID_KEY);
  }
  const committedChallenge = await challengeLifecycleRpc.getCommittedChallenge?.();
  if (committedChallenge) {
    // Active Snapshots must expose the complete derived progress object. The
    // helper also keeps Scheduled/Terminal projections on the same seam.
    return buildChallengeSnapshot(committedChallenge);
  }
  const latestCanceledChallenge = await challengeLifecycleRpc.getLatestCanceledChallenge?.();
  if (latestCanceledChallenge) return buildChallengeSnapshot(latestCanceledChallenge);
  const metadata = snapshotMetadata(health, worker, pendingCommand);
  return { ...metadata, kind: "account", account };
}

function diagnosticId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function toProtocolError(error: unknown): ProtocolError {
  const message = error instanceof Error ? error.message : String(error);
  const isConnectionError = /fetch|network|connect|supabase|failed to reach|unavailable|socket|refused|reset|aborted|json/i.test(message);
  const isUnauthorized = /unauthorized|authentication is required|verified email is required/i.test(message);
  const isBadRequest = /required|characters or fewer|consent version|adult confirmation/i.test(message);
  return {
    code: isConnectionError ? "connection_unavailable" : isUnauthorized ? "unauthorized" : isBadRequest ? "bad_request" : "internal",
    message: isConnectionError
      ? "The larp-code connection is unavailable."
      : isUnauthorized
        ? "Sign in with the verified email to continue."
        : isBadRequest
          ? message
          : "The foundation could not load current state.",
    diagnosticId: diagnosticId(),
  };
}

async function responseWithAuth(auth: NonNullable<Extract<PopupResponse, { ok: true }>['auth']>): Promise<PopupResponse> {
  return { ok: true, auth };
}

async function handleRequest(request: PopupRequest): Promise<PopupResponse> {
  try {
    switch (request.type) {
      case "get_snapshot":
        return { ok: true, snapshot: await getAppSnapshot() };
      case "request_email_otp":
      case "resend_email_otp":
        return responseWithAuth(await authSessionAdapter.requestEmailOtp(request.email));
      case "verify_email_otp": {
        const result = await authSessionAdapter.verifyEmailOtp(request.email, request.token);
        if (result.status === "authenticated") return { ok: true, snapshot: await getAppSnapshot() };
        return responseWithAuth(result);
      }
      case "create_member_account": {
        await withAuthenticatedMember(async ({ session }) => {
          const memberAccount = createMemberAccountAdapter({ rpc: memberAccountRpc, session });
          await memberAccount.createMemberAccount(request);
        });
        return { ok: true, snapshot: await getAppSnapshot() };
      }
      case "update_display_name": {
        return withAuthenticatedMember(async ({ identity }) => {
          const result = await displayNameCommands.updateDisplayName(request.displayName, identity);
          return respondToCommand({ kind: "update_display_name", result });
        });
      }
      case "create_invitation": {
        return withAuthenticatedMember(async ({ identity }) => {
          const current = await getAppSnapshot(false);
          const result = await invitationCommands.createInvitation(
            request,
            identity,
            PINNED_PROBLEM_SET_VERSION.id,
            current.authoritativeServerTime,
          );
          return respondToCommand(
            { kind: "create_invitation", result },
            async (applied) => {
              const health = await readFoundationHealth();
              const worker = await workerEvidencePromise;
              const invitation = (applied as AppliedInvitationResult).invitation;
              await rememberInvitation(invitation.id);
              return invitationSnapshot(health, worker, invitation, "inviter");
            },
          );
        });
      }
      case "revoke_invitation":
      case "decline_invitation": {
        return withAuthenticatedMember(async ({ identity }) => {
          const result = request.type === "revoke_invitation"
            ? await invitationTerminalCommands.revokeInvitation(request.invitationId, identity)
            : await invitationTerminalCommands.declineInvitation(request.invitationId, identity);
          return respondToCommand(
            { kind: request.type as "revoke_invitation" | "decline_invitation", result },
            async (applied) => {
              const health = await readFoundationHealth();
              const worker = await workerEvidencePromise;
              const invitation = (applied as AppliedInvitationResult).invitation;
              await rememberInvitation(invitation.id);
              return invitationSnapshot(
                health,
                worker,
                invitation,
                request.type === "revoke_invitation" ? "inviter" : "invitee",
              );
            },
          );
        });
      }
      case "accept_invitation": {
        return withAuthenticatedMember(async ({ identity }) => {
          const current = await getAppSnapshot(false);
          // A stale/terminal/capacity-conflicting request still goes through the
          // typed command path. The database decides the outcome, then
          // respondToCommand fetches a fresh authorized Snapshot. The
          // placeholder deliberately reveals no Invitation details to an
          // outsider and cannot authorize a write on its own.
          const invitation = current.kind === "invitation" && current.invitation.id === request.invitationId
            ? current.invitation
            : {
                id: request.invitationId,
                inviterId: "unknown",
                inviterDisplayName: "A Member",
                invitedEmail: identity.memberEmail,
                timeZone: "UTC",
                startDate: "1970-01-01",
                deadlineDate: "1970-01-01",
                problemSetVersionId: "unknown",
                status: "pending" as const,
                createdAt: "1970-01-01T00:00:00.000Z",
              };
          const result = await acceptanceCommands.acceptInvitation(invitation, identity);
          return respondToCommand(
            { kind: "accept_invitation", result },
            async (applied) => buildChallengeSnapshot((applied as AppliedAcceptanceResult).challenge),
          );
        });
      }
      case "cancel_challenge": {
        return withAuthenticatedMember(async ({ identity }) => {
          const result = await challengeCommands.cancelChallenge(request.challengeId, identity);
          return respondToCommand(
            { kind: "cancel_challenge", result },
            async (applied) => {
              const challenge = (applied as AppliedChallengeResult).challenge;
              await extensionStorage.set(LAST_CHALLENGE_ID_KEY, challenge.id);
              return buildChallengeSnapshot(challenge);
            },
          );
        });
      }
      case "abandon_challenge": {
        return withAuthenticatedMember(async ({ identity }) => {
          const result = await challengeCommands.abandonChallenge(request.challengeId, identity);
          return respondToCommand(
            { kind: "abandon_challenge", result },
            async (applied) => {
              const challenge = (applied as AppliedChallengeResult).challenge;
              await extensionStorage.set(LAST_CHALLENGE_ID_KEY, challenge.id);
              return buildChallengeSnapshot(challenge);
            },
          );
        });
      }
      case "credit_solve": {
        return withAuthenticatedMember(async ({ identity }) => {
          const result = await solveCommands.createSolve(request, identity);
          return respondToCommand(
            { kind: "create_solve", result },
            async () => getAppSnapshot(false),
          );
        });
      }
      case "correct_solve": {
        return withAuthenticatedMember(async ({ identity }) => {
          const result = await solveCorrectionCommands.correctSolve(request, identity);
          return respondToCommand(
            { kind: "correct_solve", result },
            async () => getAppSnapshot(false),
          );
        });
      }
      case "sign_out": {
        await authSessionAdapter.signOut();
        try {
          return { ok: true, snapshot: await getAppSnapshot(), auth: { status: "ready" } };
        } catch {
          return responseWithAuth({ status: "ready" });
        }
      }
    }
  } catch (error) {
    return { ok: false, error: toProtocolError(error) };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isPopupRequest(message)) return false;
  void handleRequest(message).then(sendResponse);
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== `larp-code-popup-v${PROTOCOL_VERSION}`) return;
  popupPorts.add(port);
  startRealtime();
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
    if (popupPorts.size === 0) stopRealtime();
  });
});
