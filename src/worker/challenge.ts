import {
  parseChallengeSnapshot,
  TRANSACTION_COMMAND_VERSION,
  type ChallengeAction,
  type ChallengeSnapshot,
  type ChallengeStatus,
  type PendingCommand,
} from "../shared/protocol";
import {
  createPendingCommandStore,
  type CommandIdentity,
  type PendingCommandStorage,
  sameIdentity,
} from "./command-recovery";
import { errorCode, errorMessage, errorStatus, isUnavailable } from "./errors";
import { dateInTimeZone } from "../shared/timezone";

export const CANCEL_CHALLENGE_COMMAND_KIND = "cancel_challenge" as const;
export const CANCEL_CHALLENGE_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;
export const ABANDON_CHALLENGE_COMMAND_KIND = "abandon_challenge" as const;
export const ABANDON_CHALLENGE_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;
export type ChallengeLifecycleCommandKind = typeof CANCEL_CHALLENGE_COMMAND_KIND | typeof ABANDON_CHALLENGE_COMMAND_KIND;

export type ChallengeRecord = ChallengeSnapshot;
export type ChallengeLifecycleRpc = {
  sendChallengeLifecycleCommand: (input: {
    idempotencyKey: string;
    commandVersion: typeof TRANSACTION_COMMAND_VERSION;
    commandKind: ChallengeLifecycleCommandKind;
    memberId: string;
    memberEmail: string;
    challengeId: string;
  }) => Promise<ChallengeSnapshot>;
  getCommittedChallenge?: () => Promise<ChallengeSnapshot | null>;
  getChallenge?: (challengeId: string) => Promise<ChallengeSnapshot | null>;
  getLatestCanceledChallenge?: () => Promise<ChallengeSnapshot | null>;
};

export type ChallengeLifecycleCommandResult =
  | { status: "applied"; kind: ChallengeLifecycleCommandKind; idempotencyKey: string; challenge: ChallengeSnapshot }
  | { status: "rejected"; kind: ChallengeLifecycleCommandKind; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: ChallengeLifecycleCommandKind; idempotencyKey: string; message: "Checking whether this completed." };

export type ChallengeTerminalOutcome = "completed" | "incomplete";

/**
 * Derives the whole-Challenge outcome from authoritative progress and the
 * Challenge calendar. A pair that has finished is terminal immediately; an
 * unfinished pair remains Active through the inclusive deadline date.
 */
export function deriveTerminalChallengeOutcome(
  challenge: Pick<ChallengeRecord, "status" | "deadlineDate" | "timeZone">,
  authoritativeNow: string,
  progress: { memberTotals: readonly number[] },
): ChallengeTerminalOutcome | null {
  if (challenge.status !== "active") return null;
  const memberTotals = progress.memberTotals.length === 2 ? progress.memberTotals : [0, 0];
  if (memberTotals.every((total) => total >= 150)) return "completed";
  return dateInTimeZone(authoritativeNow, challenge.timeZone) > challenge.deadlineDate ? "incomplete" : null;
}

/** Derives lifecycle state from immutable schedule fields and backend time. */
export function effectiveChallengeStatus(
  challenge: Pick<ChallengeRecord, "status" | "startDate" | "timeZone">,
  authoritativeNow: string,
): ChallengeStatus {
  if (challenge.status !== "scheduled") return challenge.status;
  return dateInTimeZone(authoritativeNow, challenge.timeZone) >= challenge.startDate ? "active" : "scheduled";
}

/** Scheduled Challenges expose cancellation only; Solve is an Active action. */
export function challengeActionsForStatus(status: ChallengeStatus): ChallengeAction[] {
  if (status === "scheduled") return ["cancel"];
  if (status === "active") return ["solve", "abandon"];
  return [];
}

export type ChallengeProjection = {
  challenge: ChallengeSnapshot;
  status: ChallengeStatus;
  actions: ChallengeAction[];
  kind: "scheduled" | "active" | "terminal";
};

/** Projects every Challenge snapshot through the same authoritative lifecycle rules. */
export function projectChallenge(
  challenge: ChallengeSnapshot,
  authoritativeNow: string,
): ChallengeProjection {
  let status = effectiveChallengeStatus(challenge, authoritativeNow);
  if (status === "active") {
    const outcome = deriveTerminalChallengeOutcome(
      challenge,
      authoritativeNow,
      { memberTotals: challenge.progress?.members.map((member) => member.creditedTotal) ?? [] },
    );
    if (outcome) status = outcome;
  }
  const solveWindowOpen = status === "active"
    && dateInTimeZone(authoritativeNow, challenge.timeZone) <= challenge.deadlineDate;
  const challengeWithoutProgress = { ...challenge };
  delete (challengeWithoutProgress as { progress?: unknown }).progress;
  return {
    challenge: status === challenge.status
      ? challenge
      : status === "active"
        ? { ...challenge, status }
        : { ...challengeWithoutProgress, status },
    status,
    actions: status === "active" && !solveWindowOpen ? [] : challengeActionsForStatus(status),
    kind: status === "scheduled" || status === "active" ? status : "terminal",
  };
}

export const parseChallenge = parseChallengeSnapshot;

function classifyFailure(error: unknown): { code: "unauthorized" | "validation" | "rate_limited"; message: string } | null {
  if (isUnavailable(error)) return null;
  const status = errorStatus(error);
  const code = errorCode(error);
  const message = errorMessage(error);
  if (status === 401 || status === 403 || code === "42501" || /authentication is required|unauthorized|verified email|not a Challenge Member/i.test(message)) {
    return { code: "unauthorized", message };
  }
  if (status === 429 || code === "P0002" || /rate.?limit|too many/i.test(message)) {
    return { code: "rate_limited", message: "Too many Challenge actions. Please wait and try again." };
  }
  if (status === 400 || status === 409 || status === 422 || code === "22023" || code === "P0003"
    || /already Active|canceled|cancel|scheduled|capacity|challenge/i.test(message)) {
    return { code: "validation", message };
  }
  return null;
}

export function createChallengeLifecycleCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: ChallengeLifecycleRpc;
  storage: PendingCommandStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const pendingStore = createPendingCommandStore(storage);

  async function sendChallengeLifecycleCommand(pending: PendingCommand): Promise<ChallengeLifecycleCommandResult> {
    if (pending.kind !== CANCEL_CHALLENGE_COMMAND_KIND && pending.kind !== ABANDON_CHALLENGE_COMMAND_KIND) {
      return { status: "uncertain", kind: CANCEL_CHALLENGE_COMMAND_KIND, idempotencyKey: pending.idempotencyKey, message: "Checking whether this completed." };
    }
    try {
      const challenge = await rpc.sendChallengeLifecycleCommand({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: TRANSACTION_COMMAND_VERSION,
        commandKind: pending.kind,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        challengeId: pending.intent.challengeId,
      });
      await pendingStore.clear(pending.idempotencyKey);
      return { status: "applied", kind: pending.kind, idempotencyKey: pending.idempotencyKey, challenge: parseChallengeSnapshot(challenge) };
    } catch (error) {
      const known = classifyFailure(error);
      if (known) {
        await pendingStore.clear(pending.idempotencyKey);
        return { status: "rejected", kind: pending.kind, ...known };
      }
      return { status: "uncertain", kind: pending.kind, idempotencyKey: pending.idempotencyKey, message: "Checking whether this completed." };
    }
  }

  async function command(
    kind: typeof CANCEL_CHALLENGE_COMMAND_KIND | typeof ABANDON_CHALLENGE_COMMAND_KIND,
    challengeId: string,
    identity: CommandIdentity,
  ): Promise<ChallengeLifecycleCommandResult> {
    const cleanChallengeId = challengeId.trim();
    if (!cleanChallengeId) return {
      status: "rejected",
      kind,
      code: "validation",
      message: "Challenge is required.",
    };
    const existing = await pendingStore.read();
    if (existing) {
      if (existing.memberId !== identity.memberId || existing.memberEmail.toLowerCase() !== identity.memberEmail.toLowerCase()) {
        await pendingStore.clear(existing.idempotencyKey);
      } else if (existing.kind !== kind || existing.intent.challengeId !== cleanChallengeId) {
        return { status: "uncertain", kind, idempotencyKey: existing.idempotencyKey, message: "Checking whether this completed." };
      } else {
        return sendChallengeLifecycleCommand(existing);
      }
    }
    const requestedAt = now();
    const pending = {
      version: CANCEL_CHALLENGE_COMMAND_VERSION,
      kind,
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail: identity.memberEmail.trim().toLowerCase(),
      intent: { challengeId: cleanChallengeId },
      requestedAt,
    } as const as Extract<PendingCommand, { kind: typeof CANCEL_CHALLENGE_COMMAND_KIND | typeof ABANDON_CHALLENGE_COMMAND_KIND }>;
    await pendingStore.persist(pending);
    return sendChallengeLifecycleCommand(pending);
  }

  async function cancelChallenge(challengeId: string, identity: CommandIdentity): Promise<ChallengeLifecycleCommandResult> {
    return command(CANCEL_CHALLENGE_COMMAND_KIND, challengeId, identity);
  }

  async function abandonChallenge(challengeId: string, identity: CommandIdentity): Promise<ChallengeLifecycleCommandResult> {
    return command(ABANDON_CHALLENGE_COMMAND_KIND, challengeId, identity);
  }

  async function recover(identity: CommandIdentity): Promise<ChallengeLifecycleCommandResult | null> {
    const pending = await pendingStore.read();
    if (!pending) return null;
    if (pending.kind !== CANCEL_CHALLENGE_COMMAND_KIND && pending.kind !== ABANDON_CHALLENGE_COMMAND_KIND) return null;
    if (!sameIdentity(pending, identity)) {
      await pendingStore.clear(pending.idempotencyKey);
      return null;
    }
    return sendChallengeLifecycleCommand(pending);
  }

  return { cancelChallenge, abandonChallenge, recover, readPending: pendingStore.read };
}
