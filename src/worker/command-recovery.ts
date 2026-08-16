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

export type RecoverableCommandFailure = {
  code: "unauthorized" | "validation" | "rate_limited";
  message: string;
};

/** One failure taxonomy shared by every recoverable domain command. */
export function classifyRecoverableCommandFailure(error: unknown): RecoverableCommandFailure | null {
  if (isUnavailable(error)) return null;
  const status = errorStatus(error);
  const code = errorCode(error);
  const message = errorMessage(error);
  if (status === 401 || status === 403 || code === "42501" || isJwtAuthFailure(error)
    || /authentication is required|unauthorized|verified email|not a Challenge Member/i.test(message)) {
    return { code: "unauthorized", message };
  }
  if (status === 429 || code === "P0002" || /rate.?limit|too many/i.test(message)) {
    return { code: "rate_limited", message: "Too many Challenge actions. Please wait and try again." };
  }
  if (status === 400 || status === 409 || status === 422 || code === "22023" || code === "P0003"
    || /already credited|already exists|active|deadline|problem|affirm|solve|challenge|correction|credit state/i.test(message)) {
    return { code: "validation", message };
  }
  return null;
}

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

export type PendingCommandStore = {
  read: () => Promise<PendingCommand | null>;
  persistIfEmpty: (pending: PendingCommand) => Promise<PendingCommand>;
  persist: (pending: PendingCommand) => Promise<void>;
  clear: (idempotencyKey?: string) => Promise<void>;
};

type PendingStoreState = { operation: Promise<void> };
const pendingStoreStates = new WeakMap<object, PendingStoreState>();

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

export function sameIdentity(
  left: Pick<PendingCommand, "memberId" | "memberEmail">,
  right: CommandIdentity,
): boolean {
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
  const storageObject = storage as unknown as object;
  const state = pendingStoreStates.get(storageObject) ?? { operation: Promise.resolve() };
  pendingStoreStates.set(storageObject, state);
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = state.operation.then(task, task);
    state.operation = result.then(() => undefined, () => undefined);
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
    /** Atomically claim the empty envelope so concurrent popup requests cannot both dispatch. */
    persistIfEmpty: (pending: PendingCommand) => enqueue(async () => {
      const existing = await readUnlocked();
      if (existing) return existing;
      await storage.set(PENDING_COMMAND_KEY, pending);
      return pending;
    }),
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

/**
 * Claims the single durable command envelope and returns the exact existing
 * command when another popup won the race. Every adapter uses this seam so
 * idempotency and uncertainty cannot drift between command families.
 */
export async function claimPendingCommand(
  pendingStore: Pick<PendingCommandStore, "persistIfEmpty">,
  pending: PendingCommand,
): Promise<PendingCommand | UncertainCommandOutcome> {
  const claimed = await pendingStore.persistIfEmpty(pending);
  if (claimed.idempotencyKey !== pending.idempotencyKey) {
    return createUncertainCommandOutcome(claimed.idempotencyKey, claimed.kind);
  }
  return claimed;
}

export function uncertainPendingCommand<K extends TransactionCommandKind>(
  pending: Pick<PendingCommand, "idempotencyKey" | "kind">,
  kind: K = pending.kind as K,
): Omit<UncertainCommandOutcome, "kind"> & { kind: K } {
  return { ...createUncertainCommandOutcome(pending.idempotencyKey, kind), kind };
}

type RecoverableCommandKind = TransactionCommandKind;
type RecoverableCommandForKind<K extends RecoverableCommandKind> = Extract<PendingCommand, { kind: K }>;

/** Shared send/recover lifecycle for every durable command envelope. */
export function createRecoverableCommandRunner<
  K extends RecoverableCommandKind,
  TApplied extends Record<string, unknown>,
  TCode extends string,
>({
  storage,
  kind,
  dispatch,
  classifyFailure,
}: {
  storage: PendingCommandStorage;
  kind: K;
  dispatch: (pending: RecoverableCommandForKind<K>) => Promise<TApplied>;
  classifyFailure: (error: unknown) => { code: TCode; message: string } | null;
}) {
  const pendingStore = createPendingCommandStore(storage);
  type Result =
    | ({ status: "applied"; kind: K; idempotencyKey: string } & TApplied)
    | { status: "rejected"; kind: K; code: TCode; message: string }
    | { status: "uncertain"; kind: K; idempotencyKey: string; message: "Checking whether this completed." };

  async function send(pending: PendingCommand): Promise<Result> {
    if (pending.kind !== kind) {
      return uncertainPendingCommand(pending, kind);
    }
    try {
      const applied = await dispatch(pending as RecoverableCommandForKind<K>);
      await pendingStore.clear(pending.idempotencyKey);
      return { status: "applied", kind, idempotencyKey: pending.idempotencyKey, ...applied };
    } catch (error) {
      const known = classifyFailure(error);
      if (known) {
        await pendingStore.clear(pending.idempotencyKey);
        return { status: "rejected", kind, ...known };
      }
      return uncertainPendingCommand(pending, kind);
    }
  }

  async function recover(identity: CommandIdentity): Promise<Result | null> {
    const pending = await pendingStore.read();
    if (!pending || pending.kind !== kind) return null;
    if (!sameIdentity(pending, identity)) {
      await pendingStore.clear(pending.idempotencyKey);
      return null;
    }
    return send(pending);
  }

  return { pendingStore, send, recover, readPending: pendingStore.read };
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
    if (pending.kind !== "update_display_name" || typeof pending.intent.displayName !== "string") {
      return uncertainPendingCommand(pending, pending.kind);
    }
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
      return uncertainPendingCommand(pending, "update_display_name");
    }
  }

  async function recover(identity: CommandIdentity): Promise<DisplayNameCommandResult | null> {
    const pending = await pendingStore.read();
    if (!pending || pending.kind !== "update_display_name") return null;
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
      } else if (existing.kind !== "update_display_name" || existing.intent.displayName !== normalized.value) {
        return uncertainPendingCommand(existing, "update_display_name");
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
    const claimed = await claimPendingCommand(pendingStore, pending);
    if ("status" in claimed) return claimed;
    return send(claimed);
  }

  return {
    updateDisplayName,
    recover,
    readPending: pendingStore.read,
    clearPending: () => pendingStore.clear(),
  };
}
