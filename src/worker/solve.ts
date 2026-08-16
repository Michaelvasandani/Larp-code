import {
  TRANSACTION_COMMAND_VERSION,
  type PendingCommand,
} from "../shared/protocol";
import {
  createPendingCommandStore,
  sameIdentity,
  type CommandIdentity,
  type PendingCommandStorage,
} from "./command-recovery";
import { errorCode, errorMessage, errorStatus, isUnavailable } from "./errors";

export const CREATE_SOLVE_COMMAND_KIND = "create_solve" as const;
export const CREATE_SOLVE_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;

export type SolveRecord = Readonly<{
  id: string;
  memberId: string;
  challengeId: string;
  problemId: string;
  claimedAt: string;
  creditStatus: "credited";
}>;

export function parseSolve(value: unknown): SolveRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The backend returned an invalid Solve.");
  }
  const row = value as Record<string, unknown>;
  const keys = ["id", "memberId", "challengeId", "problemId", "claimedAt", "creditStatus"];
  if (Object.keys(row).some((key) => !keys.includes(key))
    || !keys.every((key) => typeof row[key] === "string")
    || row.creditStatus !== "credited") {
    throw new Error("The backend returned an invalid Solve.");
  }
  return Object.freeze(row as unknown as SolveRecord);
}

export type SolveRpc = {
  createSolve: (input: {
    idempotencyKey: string;
    commandVersion: typeof CREATE_SOLVE_COMMAND_VERSION;
    commandKind: typeof CREATE_SOLVE_COMMAND_KIND;
    memberId: string;
    memberEmail: string;
    challengeId: string;
    problemId: string;
    affirmed: true;
  }) => Promise<SolveRecord>;
};

export type SolveCommandResult =
  | { status: "applied"; kind: typeof CREATE_SOLVE_COMMAND_KIND; idempotencyKey: string; solve: SolveRecord }
  | { status: "rejected"; kind: typeof CREATE_SOLVE_COMMAND_KIND; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof CREATE_SOLVE_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

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
    || /already credited|already exists|active|deadline|problem|affirm|solve|challenge/i.test(message)) {
    return { code: "validation", message };
  }
  return null;
}

export function createSolveCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: SolveRpc;
  storage: PendingCommandStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const pendingStore = createPendingCommandStore(storage);

  async function send(pending: PendingCommand): Promise<SolveCommandResult> {
    if (pending.kind !== CREATE_SOLVE_COMMAND_KIND || pending.intent.affirmed !== true) {
      return { status: "uncertain", kind: CREATE_SOLVE_COMMAND_KIND, idempotencyKey: pending.idempotencyKey, message: "Checking whether this completed." };
    }
    try {
      const solve = await rpc.createSolve({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: CREATE_SOLVE_COMMAND_VERSION,
        commandKind: CREATE_SOLVE_COMMAND_KIND,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        challengeId: pending.intent.challengeId,
        problemId: pending.intent.problemId,
        affirmed: true,
      });
      await pendingStore.clear(pending.idempotencyKey);
      return { status: "applied", kind: CREATE_SOLVE_COMMAND_KIND, idempotencyKey: pending.idempotencyKey, solve: parseSolve(solve) };
    } catch (error) {
      const known = classifyFailure(error);
      if (known) {
        await pendingStore.clear(pending.idempotencyKey);
        return { status: "rejected", kind: CREATE_SOLVE_COMMAND_KIND, ...known };
      }
      return { status: "uncertain", kind: CREATE_SOLVE_COMMAND_KIND, idempotencyKey: pending.idempotencyKey, message: "Checking whether this completed." };
    }
  }

  async function createSolve(
    intent: { challengeId: string; problemId: string; affirmed: boolean },
    identity: CommandIdentity,
  ): Promise<SolveCommandResult> {
    const challengeId = intent.challengeId.trim();
    const problemId = intent.problemId.trim();
    if (!challengeId || !problemId || intent.affirmed !== true) {
      return { status: "rejected", kind: CREATE_SOLVE_COMMAND_KIND, code: "validation", message: "Select a Problem and affirm that you completed or recompleted it during the Active Challenge." };
    }
    const existing = await pendingStore.read();
    if (existing) {
      if (!sameIdentity(existing, identity)) {
        await pendingStore.clear(existing.idempotencyKey);
      } else if (existing.kind !== CREATE_SOLVE_COMMAND_KIND
        || existing.intent.challengeId !== challengeId
        || existing.intent.problemId !== problemId
        || existing.intent.affirmed !== true) {
        return { status: "uncertain", kind: CREATE_SOLVE_COMMAND_KIND, idempotencyKey: existing.idempotencyKey, message: "Checking whether this completed." };
      } else {
        return send(existing);
      }
    }
    const pending: PendingCommand = {
      version: CREATE_SOLVE_COMMAND_VERSION,
      kind: CREATE_SOLVE_COMMAND_KIND,
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail: identity.memberEmail.trim().toLowerCase(),
      intent: { challengeId, problemId, affirmed: true },
      requestedAt: now(),
    };
    await pendingStore.persist(pending);
    return send(pending);
  }

  async function recover(identity: CommandIdentity): Promise<SolveCommandResult | null> {
    const pending = await pendingStore.read();
    if (!pending || pending.kind !== CREATE_SOLVE_COMMAND_KIND) return null;
    if (!sameIdentity(pending, identity)) {
      await pendingStore.clear(pending.idempotencyKey);
      return null;
    }
    return send(pending);
  }

  return { createSolve, recover, readPending: pendingStore.read };
}
