import {
  parseChallengeSnapshot,
  TRANSACTION_COMMAND_VERSION,
  type ChallengeAction,
  type ChallengeSnapshot,
  type ChallengeStatus,
} from "../shared/protocol";
import {
  createRecoverableCommandRunner,
  type CommandIdentity,
  type PendingCommandStorage,
} from "./command-recovery";
import { errorCode, errorMessage, errorStatus, isUnavailable } from "./errors";
import { dateInTimeZone } from "../shared/timezone";

export const CANCEL_CHALLENGE_COMMAND_KIND = "cancel_challenge" as const;
export const CANCEL_CHALLENGE_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;

export type ChallengeRecord = ChallengeSnapshot;
export type ChallengeLifecycleRpc = {
  cancelChallenge: (input: {
    idempotencyKey: string;
    commandVersion: typeof CANCEL_CHALLENGE_COMMAND_VERSION;
    commandKind: typeof CANCEL_CHALLENGE_COMMAND_KIND;
    memberId: string;
    memberEmail: string;
    challengeId: string;
  }) => Promise<ChallengeSnapshot>;
  getCommittedChallenge?: () => Promise<ChallengeSnapshot | null>;
  getChallenge?: (challengeId: string) => Promise<ChallengeSnapshot | null>;
  getLatestCanceledChallenge?: () => Promise<ChallengeSnapshot | null>;
};

export type ChallengeLifecycleCommandResult =
  | { status: "applied"; kind: typeof CANCEL_CHALLENGE_COMMAND_KIND; idempotencyKey: string; challenge: ChallengeSnapshot }
  | { status: "rejected"; kind: typeof CANCEL_CHALLENGE_COMMAND_KIND; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof CANCEL_CHALLENGE_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

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
  if (status === "active") return ["solve"];
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
  const status = effectiveChallengeStatus(challenge, authoritativeNow);
  return {
    challenge: status === challenge.status ? challenge : { ...challenge, status },
    status,
    actions: challengeActionsForStatus(status),
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
  const runner = createRecoverableCommandRunner({
    storage,
    kind: CANCEL_CHALLENGE_COMMAND_KIND,
    classifyFailure,
    dispatch: async (pending) => ({
      challenge: parseChallengeSnapshot(await rpc.cancelChallenge({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: CANCEL_CHALLENGE_COMMAND_VERSION,
        commandKind: CANCEL_CHALLENGE_COMMAND_KIND,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        challengeId: pending.intent.challengeId,
      })),
    }),
  });

  async function cancelChallenge(challengeId: string, identity: CommandIdentity): Promise<ChallengeLifecycleCommandResult> {
    const cleanChallengeId = challengeId.trim();
    if (!cleanChallengeId) return {
      status: "rejected",
      kind: CANCEL_CHALLENGE_COMMAND_KIND,
      code: "validation",
      message: "Challenge is required.",
    };
    const existing = await runner.readPending();
    if (existing) {
      if (existing.memberId !== identity.memberId || existing.memberEmail.toLowerCase() !== identity.memberEmail.toLowerCase()) {
        await runner.pendingStore.clear(existing.idempotencyKey);
      } else if (existing.kind !== CANCEL_CHALLENGE_COMMAND_KIND || existing.intent.challengeId !== cleanChallengeId) {
        return { status: "uncertain", kind: CANCEL_CHALLENGE_COMMAND_KIND, idempotencyKey: existing.idempotencyKey, message: "Checking whether this completed." };
      } else {
        return runner.send(existing) as Promise<ChallengeLifecycleCommandResult>;
      }
    }
    const requestedAt = now();
    const pending = {
      version: CANCEL_CHALLENGE_COMMAND_VERSION,
      kind: CANCEL_CHALLENGE_COMMAND_KIND,
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail: identity.memberEmail.trim().toLowerCase(),
      intent: { challengeId: cleanChallengeId },
      requestedAt,
    } as const;
    await runner.pendingStore.persist(pending);
    return runner.send(pending) as Promise<ChallengeLifecycleCommandResult>;
  }

  async function recover(identity: CommandIdentity): Promise<ChallengeLifecycleCommandResult | null> {
    return runner.recover(identity) as Promise<ChallengeLifecycleCommandResult | null>;
  }

  return { cancelChallenge, recover, readPending: runner.readPending };
}
