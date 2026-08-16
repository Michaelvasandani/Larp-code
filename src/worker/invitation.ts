import {
  TRANSACTION_COMMAND_VERSION,
  type InvitationCommandIntent,
  type InvitationTerminalCommandIntent,
  type PendingCommand,
} from "../shared/protocol";
import type { ProblemSetVersion } from "../catalog/problem-set";
import {
  createPendingCommandStore,
  claimPendingCommand,
  uncertainPendingCommand,
  sameIdentity,
  type CommandIdentity,
  type PendingCommandStorage,
} from "./command-recovery";
import { errorCode, errorMessage, errorStatus, isUnavailable } from "./errors";
import type { InvitationDetailsRecord } from "./acceptance";
import { dateInTimeZone, nextCalendarDate } from "../shared/timezone";
export {
  INVITATION_EMAIL_DISCLAIMER,
  INVITATION_EMAIL_SUBJECT,
  renderInvitationEmail,
  sanitizeInviterDisplayName,
} from "../shared/invitation-email";

/** Invitation commands deliberately use the same recoverable transaction family as ticket 22. */
export const INVITATION_COMMAND_KIND = "create_invitation" as const;
export const INVITATION_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;
export const REVOKE_INVITATION_COMMAND_KIND = "revoke_invitation" as const;
export const DECLINE_INVITATION_COMMAND_KIND = "decline_invitation" as const;

export type InvitationTermsInput = {
  invitedEmail: string;
  timeZone: string;
  startDate: string;
  deadlineDate: string;
};

export type InvitationTerms = Readonly<{
  invitedEmail: string;
  timeZone: string;
  startDate: string;
  deadlineDate: string;
}>;

export type InvitationValidation = { value: InvitationTerms } | { error: string };

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "declined" | "expired";
export type InvitationRole = "inviter" | "invitee";
export type InvitationAction = "accept" | "decline" | "revoke";

/** Derives the effective status from backend-authoritative time without requiring reconciliation. */
export function effectiveInvitationStatus(invitation: Pick<InvitationRecord, "status" | "startDate" | "timeZone">, authoritativeNow: string): InvitationStatus {
  if (invitation.status !== "pending") return invitation.status;
  return dateInTimeZone(authoritativeNow, invitation.timeZone) >= invitation.startDate ? "expired" : "pending";
}

export function invitationActionsForRole(
  role: InvitationRole,
  invitation: Pick<InvitationRecord, "status" | "startDate" | "timeZone">,
  authoritativeNow?: string,
): InvitationAction[] {
  const status = authoritativeNow === undefined ? invitation.status : effectiveInvitationStatus(invitation, authoritativeNow);
  if (status !== "pending") return [];
  return role === "inviter" ? ["revoke"] : ["accept", "decline"];
}

function isIanaTimeZone(value: string): boolean {
  if (!value || value.length > 100 || value !== value.trim()) return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return Boolean(resolved);
  } catch {
    return false;
  }
}

export function normalizeInvitationTerms(input: InvitationTermsInput, authoritativeNow: string): InvitationValidation {
  const invitedEmail = input.invitedEmail.trim().toLowerCase();
  if (!isValidEmail(invitedEmail)) return { error: "Enter one valid invited email address." };
  if (!isIanaTimeZone(input.timeZone)) return { error: "Choose a valid IANA Challenge Time Zone." };
  if (!isValidDate(input.startDate) || !isValidDate(input.deadlineDate)) {
    return { error: "Use valid inclusive Start Date and Deadline Date values." };
  }
  if (input.deadlineDate < input.startDate) return { error: "Deadline Date must be on or after Start Date." };
  const tomorrow = nextCalendarDate(dateInTimeZone(authoritativeNow, input.timeZone));
  if (input.startDate < tomorrow) {
    return { error: "Start Date must be the next calendar day or later in the Challenge Time Zone." };
  }
  return {
    value: Object.freeze({
      invitedEmail,
      timeZone: input.timeZone,
      startDate: input.startDate,
      deadlineDate: input.deadlineDate,
    }),
  };
}

export type CreateInvitationRpc = {
  createInvitation: (input: {
    idempotencyKey: string;
    commandVersion: typeof INVITATION_COMMAND_VERSION;
    commandKind: typeof INVITATION_COMMAND_KIND;
    memberId: string;
    memberEmail: string;
    terms: InvitationTerms;
    problemSetVersionId: ProblemSetVersion["id"];
  }) => Promise<InvitationRecord>;
  dispatchInvitationNotice?: (invitationId: string) => Promise<void>;
  getPendingInvitation?: () => Promise<InvitationRecord | null>;
  getPendingInvitationDetails?: () => Promise<InvitationDetailsRecord | null>;
};

export type InvitationTerminalRpcInput = {
  idempotencyKey: string;
  commandVersion: typeof INVITATION_COMMAND_VERSION;
  commandKind: typeof REVOKE_INVITATION_COMMAND_KIND | typeof DECLINE_INVITATION_COMMAND_KIND;
  memberId: string;
  memberEmail: string;
  invitationId: string;
};

export type InvitationTerminalRpc = {
  revokeInvitation?: (input: InvitationTerminalRpcInput & { commandKind: typeof REVOKE_INVITATION_COMMAND_KIND }) => Promise<InvitationRecord>;
  declineInvitation?: (input: InvitationTerminalRpcInput & { commandKind: typeof DECLINE_INVITATION_COMMAND_KIND }) => Promise<InvitationRecord>;
  getInvitation?: (invitationId: string) => Promise<InvitationRecord | null>;
  getPendingOutgoingInvitation?: () => Promise<InvitationRecord | null>;
};

export type InvitationRecord = Readonly<InvitationTerms & {
  id: string;
  inviterId: string;
  inviterDisplayName: string;
  problemSetVersionId: string;
  status: InvitationStatus;
  createdAt: string;
  terminalActorId?: string | null;
  terminalAt?: string | null;
}>;

export function parseInvitation(value: unknown): InvitationRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The backend returned an invalid Invitation.");
  }
  const row = value as Record<string, unknown>;
  const expected = ["id", "inviterId", "inviterDisplayName", "invitedEmail", "timeZone", "startDate", "deadlineDate", "problemSetVersionId", "status", "createdAt"];
  const allowed = [...expected, "terminalActorId", "terminalAt"];
  if (Object.keys(row).some((key) => !allowed.includes(key))
    || !expected.every((key) => typeof row[key] === "string")
    || !["pending", "accepted", "revoked", "declined", "expired"].includes(String(row.status))
    || (row.terminalActorId !== undefined && row.terminalActorId !== null && typeof row.terminalActorId !== "string")
    || (row.terminalAt !== undefined && row.terminalAt !== null && typeof row.terminalAt !== "string")) {
    throw new Error("The backend returned an invalid Invitation.");
  }
  return Object.freeze({
    id: row.id as string,
    inviterId: row.inviterId as string,
    inviterDisplayName: row.inviterDisplayName as string,
    invitedEmail: row.invitedEmail as string,
    timeZone: row.timeZone as string,
    startDate: row.startDate as string,
    deadlineDate: row.deadlineDate as string,
    problemSetVersionId: row.problemSetVersionId as string,
    status: row.status as InvitationStatus,
    createdAt: row.createdAt as string,
    ...(row.terminalActorId !== undefined ? { terminalActorId: row.terminalActorId as string | null } : {}),
    ...(row.terminalAt !== undefined ? { terminalAt: row.terminalAt as string | null } : {}),
  });
}

/** Kept here as a type alias so callers cannot accidentally build a second storage protocol. */
export type InvitationPendingStorage = PendingCommandStorage;

export type InvitationCommandResult =
  | { status: "applied"; kind: typeof INVITATION_COMMAND_KIND; idempotencyKey: string; invitation: InvitationRecord }
  | { status: "rejected"; kind: typeof INVITATION_COMMAND_KIND; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof INVITATION_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

export type InvitationTerminalCommandResult =
  | { status: "applied"; idempotencyKey: string; invitation: InvitationRecord }
  | { status: "rejected"; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof REVOKE_INVITATION_COMMAND_KIND | typeof DECLINE_INVITATION_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

function classifyFailure(error: unknown): { code: "unauthorized" | "validation" | "rate_limited"; message: string } | null {
  if (isUnavailable(error)) return null;
  const status = errorStatus(error);
  const code = errorCode(error);
  const message = errorMessage(error);
  if (status === 401 || status === 403 || code === "42501" || /authentication is required|unauthorized|verified email/i.test(message)) {
    return { code: "unauthorized", message };
  }
  if (status === 429 || code === "P0002" || /rate.?limit|too many/i.test(message)) {
    return { code: "rate_limited", message: "Too many Invitations. Please wait and try again." };
  }
  if (status === 400 || status === 422 || code === "22023" || /required|invalid|date|time zone|email/i.test(message)) {
    return { code: "validation", message };
  }
  return null;
}

type InvitationTransactionKind = typeof INVITATION_COMMAND_KIND | typeof REVOKE_INVITATION_COMMAND_KIND | typeof DECLINE_INVITATION_COMMAND_KIND;
type InvitationTransactionOutcome =
  | { status: "applied"; idempotencyKey: string; invitation: InvitationRecord }
  | { status: "rejected"; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: InvitationTransactionKind; idempotencyKey: string; message: "Checking whether this completed." };

function sameIntent(left: PendingCommand, kind: InvitationTransactionKind, intent: InvitationCommandIntent | InvitationTerminalCommandIntent): boolean {
  if (left.kind !== kind) return false;
  if (kind === INVITATION_COMMAND_KIND) {
    const previous = left.intent as InvitationCommandIntent;
    const next = intent as InvitationCommandIntent;
    return previous.invitedEmail === next.invitedEmail
      && previous.timeZone === next.timeZone
      && previous.startDate === next.startDate
      && previous.deadlineDate === next.deadlineDate
      && previous.problemSetVersionId === next.problemSetVersionId;
  }
  return (left.intent as InvitationTerminalCommandIntent).invitationId
    === (intent as InvitationTerminalCommandIntent).invitationId;
}

function createDurableInvitationCommandRunner({
  storage,
  send,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  storage: InvitationPendingStorage;
  send: (pending: PendingCommand, clear: (key: string) => Promise<void>) => Promise<InvitationTransactionOutcome>;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const pendingStore = createPendingCommandStore(storage);

  async function invoke(
    kind: InvitationTransactionKind,
    intent: InvitationCommandIntent | InvitationTerminalCommandIntent,
    identity: CommandIdentity,
  ): Promise<InvitationTransactionOutcome> {
    const existing = await pendingStore.read();
    if (existing) {
      if (!sameIdentity(existing, identity)) {
        await pendingStore.clear(existing.idempotencyKey);
      } else if (!sameIntent(existing, kind, intent)) {
        return uncertainPendingCommand(existing, kind);
      } else {
        return send(existing, pendingStore.clear);
      }
    }
    const pending: PendingCommand = kind === INVITATION_COMMAND_KIND
      ? {
          version: TRANSACTION_COMMAND_VERSION,
          kind: INVITATION_COMMAND_KIND,
          idempotencyKey: randomIdempotencyKey(),
          memberId: identity.memberId,
          memberEmail: identity.memberEmail.trim().toLowerCase(),
          intent: intent as InvitationCommandIntent,
          requestedAt: now(),
        }
      : {
          version: TRANSACTION_COMMAND_VERSION,
          kind: kind as typeof REVOKE_INVITATION_COMMAND_KIND | typeof DECLINE_INVITATION_COMMAND_KIND,
          idempotencyKey: randomIdempotencyKey(),
          memberId: identity.memberId,
          memberEmail: identity.memberEmail.trim().toLowerCase(),
          intent: intent as InvitationTerminalCommandIntent,
          requestedAt: now(),
        };
    const claimed = await claimPendingCommand(pendingStore, pending);
    if ("status" in claimed) return { ...claimed, kind };
    return send(claimed, pendingStore.clear);
  }

  async function recover(identity: CommandIdentity): Promise<InvitationTransactionOutcome | null> {
    const pending = await pendingStore.read();
    if (!pending || (pending.kind !== INVITATION_COMMAND_KIND
      && pending.kind !== REVOKE_INVITATION_COMMAND_KIND
      && pending.kind !== DECLINE_INVITATION_COMMAND_KIND)) return null;
    if (!sameIdentity(pending, identity)) {
      await pendingStore.clear(pending.idempotencyKey);
      return null;
    }
    return send(pending, pendingStore.clear);
  }

  return { invoke, recover, readPending: pendingStore.read };
}

export function createInvitationCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: CreateInvitationRpc;
  storage: InvitationPendingStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const runner = createDurableInvitationCommandRunner({
    storage,
    now,
    randomIdempotencyKey,
    send: async (pending, clear) => {
      if (pending.kind !== INVITATION_COMMAND_KIND) {
        return uncertainPendingCommand(pending, INVITATION_COMMAND_KIND);
      }
      const { invitedEmail, timeZone, startDate, deadlineDate, problemSetVersionId } = pending.intent;
      try {
        const invitation = await rpc.createInvitation({
          idempotencyKey: pending.idempotencyKey,
          commandVersion: INVITATION_COMMAND_VERSION,
          commandKind: INVITATION_COMMAND_KIND,
          memberId: pending.memberId,
          memberEmail: pending.memberEmail,
          terms: { invitedEmail, timeZone, startDate, deadlineDate },
          problemSetVersionId,
        });
        await rpc.dispatchInvitationNotice?.(invitation.id);
        await clear(pending.idempotencyKey);
        return { status: "applied", idempotencyKey: pending.idempotencyKey, invitation };
      } catch (error) {
        const known = classifyFailure(error);
        if (known) {
          await clear(pending.idempotencyKey);
          return { status: "rejected", ...known };
        }
        return uncertainPendingCommand(pending, INVITATION_COMMAND_KIND);
      }
    },
  });

  async function createInvitation(
    input: InvitationTermsInput,
    identity: CommandIdentity,
    problemSetVersionId: string,
    authoritativeNow: string = now(),
  ): Promise<InvitationCommandResult> {
    const normalized = normalizeInvitationTerms(input, authoritativeNow);
    if ("error" in normalized) return { status: "rejected", kind: INVITATION_COMMAND_KIND, code: "validation", message: normalized.error };
    return runner.invoke(INVITATION_COMMAND_KIND, {
      ...normalized.value,
      problemSetVersionId,
    }, identity) as Promise<InvitationCommandResult>;
  }

  async function recover(identity: CommandIdentity): Promise<InvitationCommandResult | null> {
    const pending = await runner.readPending();
    if (!pending || pending.kind !== INVITATION_COMMAND_KIND) return null;
    return runner.recover(identity) as Promise<InvitationCommandResult | null>;
  }

  return { createInvitation, recover, readPending: runner.readPending };
}

/**
 * Revoke and decline are separate commands so the server can enforce the
 * participant role while this adapter gives each action the same durable,
 * recoverable identity as Invitation creation.
 */
export function createInvitationTerminalCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: InvitationTerminalRpc;
  storage: InvitationPendingStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const runner = createDurableInvitationCommandRunner({
    storage,
    now,
    randomIdempotencyKey,
    send: async (pending, clear) => {
      if (pending.kind !== REVOKE_INVITATION_COMMAND_KIND && pending.kind !== DECLINE_INVITATION_COMMAND_KIND) {
        return uncertainPendingCommand(pending, REVOKE_INVITATION_COMMAND_KIND);
      }
      const input: InvitationTerminalRpcInput = {
        idempotencyKey: pending.idempotencyKey,
        commandVersion: INVITATION_COMMAND_VERSION,
        commandKind: pending.kind,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        invitationId: pending.intent.invitationId,
      };
      try {
        let invitation: InvitationRecord;
        if (pending.kind === REVOKE_INVITATION_COMMAND_KIND) {
          if (!rpc.revokeInvitation) return { status: "rejected", code: "validation", message: "Invitation action is unavailable." };
          invitation = await rpc.revokeInvitation(input as InvitationTerminalRpcInput & { commandKind: typeof REVOKE_INVITATION_COMMAND_KIND });
        } else {
          if (!rpc.declineInvitation) return { status: "rejected", code: "validation", message: "Invitation action is unavailable." };
          invitation = await rpc.declineInvitation(input as InvitationTerminalRpcInput & { commandKind: typeof DECLINE_INVITATION_COMMAND_KIND });
        }
        await clear(pending.idempotencyKey);
        return { status: "applied", idempotencyKey: pending.idempotencyKey, invitation };
      } catch (error) {
        const known = classifyFailure(error);
        if (known) {
          await clear(pending.idempotencyKey);
          return { status: "rejected", ...known };
        }
        return uncertainPendingCommand(pending, pending.kind);
      }
    },
  });

  async function invoke(
    kind: typeof REVOKE_INVITATION_COMMAND_KIND | typeof DECLINE_INVITATION_COMMAND_KIND,
    invitationId: string,
    identity: CommandIdentity,
  ): Promise<InvitationTerminalCommandResult> {
    const cleanInvitationId = invitationId.trim();
    if (!cleanInvitationId) return { status: "rejected", code: "validation", message: "Invitation is required." };
    return runner.invoke(kind, { invitationId: cleanInvitationId }, identity) as Promise<InvitationTerminalCommandResult>;
  }

  async function revokeInvitation(invitationId: string, identity: CommandIdentity): Promise<InvitationTerminalCommandResult> {
    return invoke(REVOKE_INVITATION_COMMAND_KIND, invitationId, identity);
  }

  async function declineInvitation(invitationId: string, identity: CommandIdentity): Promise<InvitationTerminalCommandResult> {
    return invoke(DECLINE_INVITATION_COMMAND_KIND, invitationId, identity);
  }

  async function recover(identity: CommandIdentity): Promise<InvitationTerminalCommandResult | null> {
    const pending = await runner.readPending();
    if (!pending || (pending.kind !== REVOKE_INVITATION_COMMAND_KIND && pending.kind !== DECLINE_INVITATION_COMMAND_KIND)) return null;
    return runner.recover(identity) as Promise<InvitationTerminalCommandResult | null>;
  }

  return {
    revokeInvitation,
    declineInvitation,
    recover,
    readPending: runner.readPending,
  };
}
