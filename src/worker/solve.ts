import {
  TRANSACTION_COMMAND_VERSION,
  type SolveCorrectionCategory,
  type SolveCorrectionIntent,
  type PendingCommand,
} from "../shared/protocol";
import {
  classifyRecoverableCommandFailure,
  createRecoverableCommandRunner,
  sameIdentity,
  type CommandIdentity,
  type PendingCommandStorage,
} from "./command-recovery";

export const CREATE_SOLVE_COMMAND_KIND = "create_solve" as const;
export const CREATE_SOLVE_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;
export const CORRECT_SOLVE_COMMAND_KIND = "correct_solve" as const;
export const CORRECT_SOLVE_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;

export type SolveCreditStatus = "credited" | "not_credited";
export type { SolveCorrectionCategory, SolveCorrectionIntent } from "../shared/protocol";

export type SolveRecord = Readonly<{
  id: string;
  memberId: string;
  challengeId: string;
  problemId: string;
  claimedAt: string;
  originalCreditStatus: SolveCreditStatus;
  creditStatus: SolveCreditStatus;
}>;

export function parseSolve(value: unknown): SolveRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The backend returned an invalid Solve.");
  }
  const row = value as Record<string, unknown>;
  const keys = ["id", "memberId", "challengeId", "problemId", "claimedAt", "originalCreditStatus", "creditStatus"];
  if (Object.keys(row).some((key) => !keys.includes(key))
    || !keys.every((key) => typeof row[key] === "string")
    || (row.originalCreditStatus !== "credited" && row.originalCreditStatus !== "not_credited")
    || (row.creditStatus !== "credited" && row.creditStatus !== "not_credited")) {
    throw new Error("The backend returned an invalid Solve.");
  }
  return Object.freeze(row as unknown as SolveRecord);
}

export type SolveCorrectionRecord = Readonly<{
  id: string;
  solveId: string;
  challengeId: string;
  actorId: string;
  correctedAt: string;
  category: SolveCorrectionCategory;
  reason: string;
  resultingCreditStatus: SolveCreditStatus;
  sequence: number;
}>;

export function parseSolveCorrection(value: unknown): SolveCorrectionRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The backend returned an invalid Solve Correction.");
  }
  const row = value as Record<string, unknown>;
  const keys = ["id", "solveId", "challengeId", "actorId", "correctedAt", "category", "reason", "resultingCreditStatus", "sequence"];
  if (Object.keys(row).some((key) => !keys.includes(key))
    || !keys.filter((key) => key !== "sequence").every((key) => typeof row[key] === "string")
    || (row.resultingCreditStatus !== "credited" && row.resultingCreditStatus !== "not_credited")
    || typeof row.sequence !== "number" || !Number.isInteger(row.sequence) || row.sequence < 1) {
    throw new Error("The backend returned an invalid Solve Correction.");
  }
  return Object.freeze(row as unknown as SolveCorrectionRecord);
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

export type SolveCorrectionRpc = {
  correctSolve: (input: {
    idempotencyKey: string;
    commandVersion: typeof CORRECT_SOLVE_COMMAND_VERSION;
    commandKind: typeof CORRECT_SOLVE_COMMAND_KIND;
    memberId: string;
    memberEmail: string;
    challengeId: string;
    solveId: string;
    category: SolveCorrectionCategory;
    reason: string;
    resultingCreditStatus: SolveCreditStatus;
  }) => Promise<SolveCorrectionRecord>;
};

export type SolveCorrectionCommandResult =
  | { status: "applied"; kind: typeof CORRECT_SOLVE_COMMAND_KIND; idempotencyKey: string; correction: SolveCorrectionRecord }
  | { status: "rejected"; kind: typeof CORRECT_SOLVE_COMMAND_KIND; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof CORRECT_SOLVE_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

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
  const runner = createRecoverableCommandRunner({
    storage,
    kind: CREATE_SOLVE_COMMAND_KIND,
    classifyFailure: classifyRecoverableCommandFailure,
    dispatch: async (pending) => ({
      solve: parseSolve(await rpc.createSolve({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: CREATE_SOLVE_COMMAND_VERSION,
        commandKind: CREATE_SOLVE_COMMAND_KIND,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        challengeId: pending.intent.challengeId,
        problemId: pending.intent.problemId,
        affirmed: true,
      })),
    }),
  });

  async function createSolve(
    intent: { challengeId: string; problemId: string; affirmed: boolean },
    identity: CommandIdentity,
  ): Promise<SolveCommandResult> {
    const challengeId = intent.challengeId.trim();
    const problemId = intent.problemId.trim();
    if (!challengeId || !problemId || intent.affirmed !== true) {
      return { status: "rejected", kind: CREATE_SOLVE_COMMAND_KIND, code: "validation", message: "Select a Problem and affirm that you completed or recompleted it during the Active Challenge." };
    }
    const existing = await runner.readPending();
    if (existing) {
      if (!sameIdentity(existing, identity)) {
        await runner.pendingStore.clear(existing.idempotencyKey);
      } else if (existing.kind !== CREATE_SOLVE_COMMAND_KIND
        || existing.intent.challengeId !== challengeId
        || existing.intent.problemId !== problemId
        || existing.intent.affirmed !== true) {
        return { status: "uncertain", kind: CREATE_SOLVE_COMMAND_KIND, idempotencyKey: existing.idempotencyKey, message: "Checking whether this completed." };
      } else {
        return runner.send(existing) as Promise<SolveCommandResult>;
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
    await runner.pendingStore.persist(pending);
    return runner.send(pending) as Promise<SolveCommandResult>;
  }

  async function recover(identity: CommandIdentity): Promise<SolveCommandResult | null> {
    return runner.recover(identity) as Promise<SolveCommandResult | null>;
  }

  return { createSolve, recover, readPending: runner.readPending };
}

export function createSolveCorrectionCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: SolveCorrectionRpc;
  storage: PendingCommandStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const runner = createRecoverableCommandRunner({
    storage,
    kind: CORRECT_SOLVE_COMMAND_KIND,
    classifyFailure: classifyRecoverableCommandFailure,
    dispatch: async (pending) => ({
      correction: parseSolveCorrection(await rpc.correctSolve({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: CORRECT_SOLVE_COMMAND_VERSION,
        commandKind: CORRECT_SOLVE_COMMAND_KIND,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        challengeId: pending.intent.challengeId,
        solveId: pending.intent.solveId,
        category: pending.intent.category,
        reason: pending.intent.reason,
        resultingCreditStatus: pending.intent.resultingCreditStatus,
      })),
    }),
  });

  async function correctSolve(
    input: SolveCorrectionIntent,
    identity: CommandIdentity,
  ): Promise<SolveCorrectionCommandResult> {
    const challengeId = input.challengeId.trim();
    const solveId = input.solveId.trim();
    const category = input.category.trim().toLowerCase() as SolveCorrectionCategory;
    const reason = input.reason.trim();
    if (!challengeId || !solveId || !category || !reason
      || !["retracted", "reclassified", "restored"].includes(category)
      || reason.length > 500 || category.length > 80
      || (input.resultingCreditStatus !== "credited" && input.resultingCreditStatus !== "not_credited")) {
      return {
        status: "rejected",
        kind: CORRECT_SOLVE_COMMAND_KIND,
        code: "validation",
        message: "A Solve, correction category, reason, and resulting credit state are required.",
      };
    }
    const existing = await runner.readPending();
    if (existing) {
      if (!sameIdentity(existing, identity)) {
        await runner.pendingStore.clear(existing.idempotencyKey);
      } else if (existing.kind !== CORRECT_SOLVE_COMMAND_KIND
        || existing.intent.challengeId !== challengeId
        || existing.intent.solveId !== solveId
        || existing.intent.category !== category
        || existing.intent.reason !== reason
        || existing.intent.resultingCreditStatus !== input.resultingCreditStatus) {
        return { status: "uncertain", kind: CORRECT_SOLVE_COMMAND_KIND, idempotencyKey: existing.idempotencyKey, message: "Checking whether this completed." };
      } else {
        return runner.send(existing) as Promise<SolveCorrectionCommandResult>;
      }
    }
    const pending: PendingCommand = {
      version: CORRECT_SOLVE_COMMAND_VERSION,
      kind: CORRECT_SOLVE_COMMAND_KIND,
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail: identity.memberEmail.trim().toLowerCase(),
      intent: { challengeId, solveId, category, reason, resultingCreditStatus: input.resultingCreditStatus },
      requestedAt: now(),
    };
    await runner.pendingStore.persist(pending);
    return runner.send(pending) as Promise<SolveCorrectionCommandResult>;
  }

  async function recover(identity: CommandIdentity): Promise<SolveCorrectionCommandResult | null> {
    return runner.recover(identity) as Promise<SolveCorrectionCommandResult | null>;
  }

  return { correctSolve, recover, readPending: runner.readPending };
}
