import {
  isPendingCommand,
  createUncertainCommandOutcome,
  TRANSACTION_COMMAND_VERSION,
  type MemberAccount,
  type PendingCommand,
  type TransactionCommandKind,
  type UncertainCommandOutcome,
} from "../shared/protocol";
import { normalizeDisplayName } from "./member-account";
import { errorCode, errorMessage, errorStatus, isJwtAuthFailure, isUnavailable } from "./errors";

/** Minimal asynchronous storage boundary used by command recovery. */
export type PendingCommandStorage = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export type CommandIdentity = {
  memberId: string;
  memberEmail: string;
};

export type DisplayNameCommandRpc = {
  updateDisplayName: (input: {
    idempotencyKey: string;
    commandVersion: typeof TRANSACTION_COMMAND_VERSION;
    commandKind: TransactionCommandKind;
    memberId: string;
    memberEmail: string;
    displayName: string;
  }) => Promise<MemberAccount>;
};

export type DisplayNameCommandResult =
  | { status: "applied"; idempotencyKey: string; account: MemberAccount }
  | { status: "rejected"; code: "unauthorized" | "validation"; message: string }
  | UncertainCommandOutcome;

export const PENDING_COMMAND_KEY = "command.pending";

function classifyKnownFailure(error: unknown): { code: "unauthorized" | "validation"; message: string } | null {
  if (isUnavailable(error)) return null;
  const status = errorStatus(error);
  const code = errorCode(error);
  const message = errorMessage(error);
  if (status === 401 || status === 403 || code === "42501" || isJwtAuthFailure(error)
    || /authentication is required|unauthorized|verified email/i.test(message)) {
    return { code: "unauthorized", message };
  }
  if (status === 400 || status === 422 || code === "22023" || /display name|invalid|must be|required/i.test(message)) {
    return { code: "validation", message };
  }
  return null;
}

function sameIdentity(left: PendingCommand, right: CommandIdentity): boolean {
  return left.memberId === right.memberId
    && left.memberEmail.toLowerCase() === right.memberEmail.toLowerCase();
}

export function isPendingCommandForIdentity(pending: PendingCommand, identity: CommandIdentity): boolean {
  return sameIdentity(pending, identity);
}

/**
 * Serializes writes to the one pending command envelope. This is deliberately
 * independent of worker globals so future domain commands can use the seam.
 */
export function createPendingCommandStore(storage: PendingCommandStorage) {
  let operation = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = operation.then(task, task);
    operation = result.then(() => undefined, () => undefined);
    return result;
  };

  async function readUnlocked(): Promise<PendingCommand | null> {
    const value = await storage.get(PENDING_COMMAND_KEY);
    if (value === null || value === undefined) return null;
    if (!isPendingCommand(value)) {
      await storage.remove(PENDING_COMMAND_KEY);
      return null;
    }
    return value;
  }

  return {
    read: () => enqueue(readUnlocked),
    persist: (pending: PendingCommand) => enqueue(async () => {
      const existing = await readUnlocked();
      if (existing && existing.idempotencyKey !== pending.idempotencyKey) {
        throw new Error("A domain command is already awaiting recovery.");
      }
      await storage.set(PENDING_COMMAND_KEY, pending);
    }),
    clear: (idempotencyKey?: string) => enqueue(async () => {
      if (idempotencyKey) {
        const existing = await readUnlocked();
        if (!existing || existing.idempotencyKey !== idempotencyKey) return;
      }
      await storage.remove(PENDING_COMMAND_KEY);
    }),
  };
}

export function createDisplayNameCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: DisplayNameCommandRpc;
  storage: PendingCommandStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const pendingStore = createPendingCommandStore(storage);

  async function send(pending: PendingCommand): Promise<DisplayNameCommandResult> {
    try {
      const account = await rpc.updateDisplayName({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: pending.version,
        commandKind: pending.kind,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        displayName: pending.intent.displayName,
      });
      await pendingStore.clear(pending.idempotencyKey);
      return { status: "applied", idempotencyKey: pending.idempotencyKey, account };
    } catch (error) {
      const known = classifyKnownFailure(error);
      if (known) {
        await pendingStore.clear(pending.idempotencyKey);
        return { status: "rejected", ...known };
      }
      return createUncertainCommandOutcome(pending.idempotencyKey);
    }
  }

  async function recover(identity: CommandIdentity): Promise<DisplayNameCommandResult | null> {
    const pending = await pendingStore.read();
    if (!pending) return null;
    if (!sameIdentity(pending, identity)) {
      await pendingStore.clear(pending.idempotencyKey);
      return null;
    }
    return send(pending);
  }

  async function updateDisplayName(displayNameInput: string, identity: CommandIdentity): Promise<DisplayNameCommandResult> {
    const normalized = normalizeDisplayName(displayNameInput);
    if ("error" in normalized) return { status: "rejected", code: "validation", message: normalized.error };

    const existing = await pendingStore.read();
    if (existing) {
      if (!sameIdentity(existing, identity)) {
        await pendingStore.clear(existing.idempotencyKey);
      } else if (existing.intent.displayName !== normalized.value) {
        return createUncertainCommandOutcome(existing.idempotencyKey);
      } else {
        return (await send(existing));
      }
    }

    const pending: PendingCommand = {
      version: TRANSACTION_COMMAND_VERSION,
      kind: "update_display_name",
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail: identity.memberEmail.trim().toLowerCase(),
      intent: { displayName: normalized.value },
      requestedAt: now(),
    };
    await pendingStore.persist(pending);
    return send(pending);
  }

  return {
    updateDisplayName,
    recover,
    readPending: pendingStore.read,
    clearPending: () => pendingStore.clear(),
  };
}
