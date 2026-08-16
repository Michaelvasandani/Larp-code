import type { AuthErrorLike, AuthSession, MemberStorage } from "./auth-session";
import {
  claimPendingCommand,
  createPendingCommandStore,
  sameIdentity,
  type CommandIdentity,
} from "./command-recovery";
import { isUnavailable } from "./errors";
import {
  DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
  DELETE_MEMBER_ACCOUNT_COMMAND_VERSION,
  type PendingCommand,
} from "../shared/protocol";

export { DELETE_MEMBER_ACCOUNT_COMMAND_KIND, DELETE_MEMBER_ACCOUNT_COMMAND_VERSION };

export const DELETION_CONFIRMATION_PHRASE = "DELETE MY ACCOUNT" as const;

type AuthResult<T> = { data: T; error: AuthErrorLike | null };

/** The small auth surface needed to prove a fresh email confirmation. */
export type AccountDeletionAuth = {
  requestDeletionOtp: (email: string) => Promise<{ error: AuthErrorLike | null }>;
  verifyDeletionOtp: (input: { email: string; token: string }) => Promise<AuthResult<{ session: AuthSession | null }>>;
  signOut: (options?: { scope?: "local" | "global" | "others" }) => Promise<{ error: AuthErrorLike | null }>;
};

export type AccountDeletionRpc = {
  deleteMemberAccount: (input: {
    idempotencyKey: string;
    commandVersion: typeof DELETE_MEMBER_ACCOUNT_COMMAND_VERSION;
    commandKind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND;
    memberId: string;
    memberEmail: string;
  }) => Promise<{ deletedMemberId: string; deletedAt: string }>;
};

export function parseDeletionReceipt(value: unknown): { deletedMemberId: string; deletedAt: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The backend returned an invalid deletion receipt.");
  }
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.deletedMemberId !== "string" || !receipt.deletedMemberId
    || typeof receipt.deletedAt !== "string" || !receipt.deletedAt) {
    throw new Error("The backend returned an invalid deletion receipt.");
  }
  return { deletedMemberId: receipt.deletedMemberId, deletedAt: receipt.deletedAt };
}

export type AccountDeletionInput = {
  confirmation: string;
  otp: string;
};

export type AccountDeletionResult =
  | { status: "applied"; kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND; idempotencyKey: string; deletedMemberId: string; deletedAt: string }
  | { status: "rejected"; kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

const OTP_PATTERN = /^\d{6}$/;

function lowerEmail(value: string): string {
  return value.trim().toLowerCase();
}

function knownFailure(error: unknown): { code: "unauthorized" | "validation" | "rate_limited"; message: string } | null {
  if (isUnavailable(error)) return null;
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof value.status === "number" ? value.status : undefined;
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : String(error);
  if (status === 429 || code === "P0002" || /rate.?limit|too many/i.test(message)) {
    return { code: "rate_limited", message: "Too many deletion confirmations. Please wait and try again." };
  }
  if (status === 401 || status === 403 || code === "42501" || /authentication|unauthorized|verified email|confirmation|token.*invalid|expired/i.test(message)) {
    return { code: "unauthorized", message };
  }
  if (status === 400 || status === 409 || status === 422 || code === "22023" || code === "P0003") {
    return { code: "validation", message };
  }
  return null;
}

function uncertain(idempotencyKey: string): AccountDeletionResult {
  return {
    status: "uncertain",
    kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
    idempotencyKey,
    message: "Checking whether this completed.",
  };
}

/**
 * Owns the destructive command's confirmation, durable idempotency envelope,
 * and final local erase. A successful server result is the only point at which
 * the extension clears its session, drafts, caches, and pending commands.
 */
export function createAccountDeletionAdapter({
  auth,
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  auth: AccountDeletionAuth;
  rpc: AccountDeletionRpc;
  storage: MemberStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const pendingStore = createPendingCommandStore(storage);

  async function eraseLocalState(): Promise<void> {
    try { await auth.signOut({ scope: "local" }); } catch { /* storage cleanup remains authoritative */ }
    await storage.clear();
  }

  async function dispatch(
    pending: Extract<PendingCommand, { kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND }>,
    resolvingExistingAccount: boolean = false,
  ): Promise<AccountDeletionResult> {
    try {
      const result = await rpc.deleteMemberAccount({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: DELETE_MEMBER_ACCOUNT_COMMAND_VERSION,
        commandKind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
      });
      await pendingStore.clear(pending.idempotencyKey);
      await eraseLocalState();
      return {
        status: "applied",
        kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
        idempotencyKey: pending.idempotencyKey,
        deletedMemberId: result.deletedMemberId,
        deletedAt: result.deletedAt,
      };
    } catch (error) {
      const known = knownFailure(error);
      if (known) {
        await pendingStore.clear(pending.idempotencyKey);
        if (resolvingExistingAccount && known.code === "unauthorized") await eraseLocalState();
        return { status: "rejected", kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND, ...known };
      }
      return uncertain(pending.idempotencyKey);
    }
  }

  async function requestDeletionOtp(emailInput: string): Promise<{ status: "code_sent" | "invalid_email" | "service_unavailable" | "rate_limited" }> {
    const email = lowerEmail(emailInput);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return { status: "invalid_email" };
    try {
      const { error } = await auth.requestDeletionOtp(email);
      if (!error) return { status: "code_sent" };
      const known = knownFailure(error);
      if (known?.code === "rate_limited") return { status: "rate_limited" };
      if (isUnavailable(error)) return { status: "service_unavailable" };
      // Keep account existence and confirmation delivery indistinguishable.
      return { status: "code_sent" };
    } catch (error) {
      return isUnavailable(error) ? { status: "service_unavailable" } : { status: "code_sent" };
    }
  }

  async function verifyFreshOtp(email: string, memberId: string, otp: string): Promise<AccountDeletionResult | null> {
    try {
      const result = await auth.verifyDeletionOtp({ email, token: otp });
      if (result.error) {
        const known = knownFailure(result.error);
        return { status: "rejected", kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND, ...(known ?? {
          code: "unauthorized" as const,
          message: "The deletion confirmation code is invalid or expired.",
        }) };
      }
      const session = result.data.session;
      if (!session || session.user.id !== memberId || session.user.email?.toLowerCase() !== email) {
        return {
          status: "rejected",
          kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
          code: "unauthorized",
          message: "The deletion confirmation code did not authenticate this Member.",
        };
      }
      return null;
    } catch (error) {
      const known = knownFailure(error);
      return {
        status: "rejected",
        kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
        ...(known ?? { code: "unauthorized" as const, message: "The deletion confirmation code is invalid or expired." }),
      };
    }
  }

  async function deleteAccount(input: AccountDeletionInput, identity: CommandIdentity): Promise<AccountDeletionResult> {
    if (input.confirmation !== DELETION_CONFIRMATION_PHRASE) {
      return { status: "rejected", kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND, code: "validation", message: `Type ${DELETION_CONFIRMATION_PHRASE} to confirm irreversible deletion.` };
    }
    if (!OTP_PATTERN.test(input.otp)) {
      return { status: "rejected", kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND, code: "validation", message: "Enter the six-digit deletion confirmation code." };
    }
    const memberEmail = lowerEmail(identity.memberEmail);
    const verificationFailure = await verifyFreshOtp(memberEmail, identity.memberId, input.otp);
    if (verificationFailure) return verificationFailure;

    const existing = await pendingStore.read();
    if (existing) {
      if (!sameIdentity(existing, { memberId: identity.memberId, memberEmail })) await pendingStore.clear(existing.idempotencyKey);
      else if (existing.kind !== DELETE_MEMBER_ACCOUNT_COMMAND_KIND) return uncertain(existing.idempotencyKey);
      else return dispatch(existing);
    }
    const pending: Extract<PendingCommand, { kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND }> = {
      version: DELETE_MEMBER_ACCOUNT_COMMAND_VERSION,
      kind: DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail,
      intent: { confirmation: true },
      requestedAt: now(),
    };
    const claimed = await claimPendingCommand(pendingStore, pending);
    if ("status" in claimed) return uncertain(claimed.idempotencyKey);
    return dispatch(claimed as Extract<PendingCommand, { kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND }>);
  }

  async function recover(identity: CommandIdentity): Promise<AccountDeletionResult | null> {
    const pending = await pendingStore.read();
    if (!pending || pending.kind !== DELETE_MEMBER_ACCOUNT_COMMAND_KIND) return null;
    if (!sameIdentity(pending, { memberId: identity.memberId, memberEmail: lowerEmail(identity.memberEmail) })) {
      await pendingStore.clear(pending.idempotencyKey);
      return null;
    }
    return dispatch(pending as Extract<PendingCommand, { kind: typeof DELETE_MEMBER_ACCOUNT_COMMAND_KIND }>, true);
  }

  return { requestDeletionOtp, deleteAccount, recover, readPending: pendingStore.read };
}
