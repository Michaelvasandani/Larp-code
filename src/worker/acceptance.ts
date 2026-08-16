import {
  TRANSACTION_COMMAND_VERSION,
  type ChallengeSnapshot,
  type Invitation,
  parseChallengeSnapshot,
  parseInvitationDetails as parseSharedInvitationDetails,
  type InvitationDetailsRecord,
  type PendingCommand,
} from "../shared/protocol";
import {
  createRecoverableCommandRunner,
  sameIdentity,
  type CommandIdentity,
  type PendingCommandStorage,
} from "./command-recovery";
import { errorCode, errorMessage, errorStatus, isUnavailable } from "./errors";

/** Acceptance has its own operation identity while sharing the durable command envelope. */
export const ACCEPT_INVITATION_COMMAND_KIND = "accept_invitation" as const;
export const ACCEPT_INVITATION_COMMAND_VERSION = TRANSACTION_COMMAND_VERSION;

export type AcceptanceInvitation = Invitation;
export { parseSharedInvitationDetails as parseInvitationDetails };
export type { InvitationDetailsRecord };

export type AcceptanceRpc = {
  acceptInvitation: (input: {
    idempotencyKey: string;
    commandVersion: typeof ACCEPT_INVITATION_COMMAND_VERSION;
    commandKind: typeof ACCEPT_INVITATION_COMMAND_KIND;
    memberId: string;
    memberEmail: string;
    invitationId: string;
  }) => Promise<ChallengeSnapshot>;
};

export const parseChallenge = parseChallengeSnapshot;

export type AcceptanceCommandResult =
  | { status: "applied"; kind: typeof ACCEPT_INVITATION_COMMAND_KIND; idempotencyKey: string; challenge: ChallengeSnapshot }
  | { status: "rejected"; kind: typeof ACCEPT_INVITATION_COMMAND_KIND; code: "unauthorized" | "validation" | "rate_limited"; message: string }
  | { status: "uncertain"; kind: typeof ACCEPT_INVITATION_COMMAND_KIND; idempotencyKey: string; message: "Checking whether this completed." };

function classifyFailure(error: unknown): { code: "unauthorized" | "validation" | "rate_limited"; message: string } | null {
  if (isUnavailable(error)) return null;
  const status = errorStatus(error);
  const code = errorCode(error);
  const message = errorMessage(error);
  if (status === 401 || status === 403 || code === "42501" || /authentication is required|unauthorized|invited email|verified email/i.test(message)) {
    return { code: "unauthorized", message };
  }
  if (status === 429 || code === "P0002" || /rate.?limit|too many/i.test(message)) {
    return { code: "rate_limited", message: "Too many acceptance attempts. Please wait and try again." };
  }
  if (status === 400 || status === 409 || status === 422 || code === "22023" || code === "P0003"
    || /not pending|expired|start date|capacity|committed challenge|terms|already accepted|no longer available/i.test(message)) {
    return { code: "validation", message };
  }
  return null;
}


function sameInvitation(pending: Extract<PendingCommand, { kind: typeof ACCEPT_INVITATION_COMMAND_KIND }>, invitation: AcceptanceInvitation): boolean {
  return pending.intent.invitationId === invitation.id;
}

/** Recoverable, account-bound acceptance command adapter. The database remains authoritative for time and capacity. */
export function createAcceptInvitationCommandAdapter({
  rpc,
  storage,
  now = () => new Date().toISOString(),
  randomIdempotencyKey = () => crypto.randomUUID(),
}: {
  rpc: AcceptanceRpc;
  storage: PendingCommandStorage;
  now?: () => string;
  randomIdempotencyKey?: () => string;
}) {
  const runner = createRecoverableCommandRunner({
    storage,
    kind: ACCEPT_INVITATION_COMMAND_KIND,
    classifyFailure,
    dispatch: async (pending) => ({
      challenge: parseChallengeSnapshot(await rpc.acceptInvitation({
        idempotencyKey: pending.idempotencyKey,
        commandVersion: ACCEPT_INVITATION_COMMAND_VERSION,
        commandKind: ACCEPT_INVITATION_COMMAND_KIND,
        memberId: pending.memberId,
        memberEmail: pending.memberEmail,
        invitationId: pending.intent.invitationId,
      })),
    }),
  });

  async function acceptInvitation(invitation: AcceptanceInvitation, identity: CommandIdentity): Promise<AcceptanceCommandResult> {
    if (identity.memberEmail.trim().toLowerCase() !== invitation.invitedEmail.trim().toLowerCase()) {
      return {
        status: "rejected",
        kind: ACCEPT_INVITATION_COMMAND_KIND,
        code: "unauthorized",
        message: "Sign in with the invited email to accept this Invitation.",
      };
    }
    const existing = await runner.readPending();
    if (existing) {
      if (!sameIdentity(existing, identity)) {
        await runner.pendingStore.clear(existing.idempotencyKey);
      } else if (existing.kind !== ACCEPT_INVITATION_COMMAND_KIND || !sameInvitation(existing, invitation)) {
        return { status: "uncertain", kind: ACCEPT_INVITATION_COMMAND_KIND, idempotencyKey: existing.idempotencyKey, message: "Checking whether this completed." };
      } else {
        return runner.send(existing);
      }
    }
    const pending = {
      version: ACCEPT_INVITATION_COMMAND_VERSION,
      kind: ACCEPT_INVITATION_COMMAND_KIND,
      idempotencyKey: randomIdempotencyKey(),
      memberId: identity.memberId,
      memberEmail: identity.memberEmail.trim().toLowerCase(),
      intent: { invitationId: invitation.id },
      requestedAt: now(),
    } satisfies PendingCommand;
    await runner.pendingStore.persist(pending);
    return runner.send(pending);
  }

  async function recover(identity: CommandIdentity): Promise<AcceptanceCommandResult | null> {
    return runner.recover(identity);
  }

  return { acceptInvitation, recover, readPending: runner.readPending };
}

/** Alias retained for callers that name the operation as Invitation acceptance. */
export const createInvitationAcceptanceCommandAdapter = createAcceptInvitationCommandAdapter;
