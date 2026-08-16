/**
 * The complete product-level mail contract. Authentication codes are shown
 * here so the matrix is complete, but are delivered by the authentication
 * provider rather than this outbox. No progress, Pet, reminder, or marketing
 * event is a member of this list.
 */
export const TRANSACTIONAL_NOTICE_MATRIX = [
  { type: "sign_in_code", recipient: "authenticating_member", source: "authentication_provider" },
  { type: "account_security", recipient: "affected_member", source: "authentication_provider" },
  { type: "invitation", recipient: "invitee", source: "product_outbox" },
  { type: "invitation_accepted", recipient: "inviter", source: "product_outbox" },
  { type: "invitation_declined", recipient: "inviter", source: "product_outbox" },
  { type: "invitation_revoked", recipient: "invitee", source: "product_outbox" },
  { type: "challenge_canceled", recipient: "non_actor_member", source: "product_outbox" },
  { type: "challenge_abandoned", recipient: "non_actor_member", source: "product_outbox" },
  { type: "challenge_account_ended", recipient: "non_actor_member", source: "product_outbox" },
] as const;

export type TransactionalNoticeType = (typeof TRANSACTIONAL_NOTICE_MATRIX)[number]["type"];
export const AUTHENTICATION_NOTICE_TYPES = ["sign_in_code", "account_security"] as const;
export type ProductNoticeType = Exclude<TransactionalNoticeType, (typeof AUTHENTICATION_NOTICE_TYPES)[number]>;

export type TransactionalNotice = Readonly<{
  eventKey: string;
  type: ProductNoticeType;
  recipientEmail: string;
  recipientMemberId?: string;
  inviterDisplayName?: string;
  invitationId?: string;
  challengeId?: string;
}>;

export type TransactionalEmail = Readonly<{
  to: string;
  subject: string;
  text: string;
  /** Product mail is deliberately sent without opens/clicks tracking. */
  tracking: false;
}>;

export type AuthenticationCodeEmail = Readonly<{
  to?: string;
  subject: string;
  text: string;
  tracking: false;
}>;

export const PRODUCT_NOTICE_METADATA = TRANSACTIONAL_NOTICE_MATRIX.filter(({ source }) => source === "product_outbox");
const NOTICE_TYPES = new Set<string>(TRANSACTIONAL_NOTICE_MATRIX.map(({ type }) => type));

export function isPermittedTransactionalNotice(value: string): value is TransactionalNoticeType {
  return NOTICE_TYPES.has(value);
}

function cleanDisplayName(value: string): string {
  return value.replace(/[\r\n\p{Cc}]/gu, " ").trim() || "A Member";
}

function identifier(value: string | undefined, label: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${label} is required to render a transactional notice.`);
  return result;
}

/**
 * Derive the sole non-actor recipient for a lifecycle event. The command
 * response remains the actor's immediate authenticated confirmation; this
 * function intentionally returns null when the actor is the only recipient.
 */
export function noticeRecipient(type: ProductNoticeType, input: {
  actorMemberId?: string;
  inviterMemberId?: string;
  inviterEmail?: string;
  inviteeMemberId?: string;
  inviteeEmail?: string;
  memberId?: string;
  otherMemberId?: string;
  otherMemberEmail?: string;
}): { memberId?: string; email: string } | null {
  const recipient = type === "invitation_accepted" || type === "invitation_declined"
    ? { memberId: input.inviterMemberId, email: input.inviterEmail }
    : type === "invitation_revoked"
      ? { memberId: input.inviteeMemberId, email: input.inviteeEmail }
      : type === "challenge_canceled" || type === "challenge_abandoned" || type === "challenge_account_ended"
        ? { memberId: input.otherMemberId, email: input.otherMemberEmail }
        : null;
  if (!recipient || !recipient.email || recipient.memberId === input.actorMemberId) return null;
  return { memberId: recipient.memberId, email: recipient.email };
}

const COPY: Record<ProductNoticeType, (notice: TransactionalNotice) => string> = {
  invitation: (notice) => `${cleanDisplayName(notice.inviterDisplayName ?? "A Member")} invited you to larp-code.\n\nSign in to larp-code with the invited email to view the Invitation details.`,
  invitation_accepted: () => "Your larp-code Invitation was accepted.\n\nSign in to larp-code to view the authenticated Invitation details.",
  invitation_declined: () => "Your larp-code Invitation was declined.\n\nSign in to larp-code to view the authenticated Invitation details.",
  invitation_revoked: () => "A larp-code Invitation was revoked.\n\nSign in to larp-code to view the authenticated Invitation details.",
  challenge_canceled: () => "Your shared larp-code Challenge was canceled.\n\nSign in to larp-code to view the authenticated Challenge record.",
  challenge_abandoned: () => "Your shared larp-code Challenge was abandoned.\n\nSign in to larp-code to view the authenticated Challenge record.",
  challenge_account_ended: () => "Your shared larp-code Challenge ended because the other Member's account is no longer available.\n\nSign in to larp-code to view the authenticated Challenge record.",
};

export function renderTransactionalNoticeEmail(notice: TransactionalNotice): TransactionalEmail {
  const type = notice.type;
  const invitationId = notice.invitationId;
  if (type === "invitation" && !invitationId) {
    throw new Error("Invitation ID is required to render an Invitation notice.");
  }
  const subject = type === "invitation"
    ? "You have a larp-code Invitation"
    : type === "challenge_account_ended"
      ? "Your larp-code Challenge ended"
      : "Your larp-code account has an update";
  const suffix = type === "invitation" ? `\n\nInvitation ${identifier(invitationId, "Invitation ID")}.` : "";
  return Object.freeze({
    to: notice.recipientEmail,
    subject,
    text: `${COPY[type](notice)}${suffix}`,
    tracking: false,
  });
}

/** Authentication mail is the only product email allowed to carry an OTP. */
export function renderAuthenticationCodeEmail(input: { token: string }): AuthenticationCodeEmail {
  if (!/^\d{6}$/.test(input.token)) throw new Error("A six-digit authentication code is required.");
  return Object.freeze({
    subject: "Your larp-code sign-in code",
    text: `Your six-digit larp-code sign-in code is ${input.token}.`,
    tracking: false,
  });
}

export type ReplaceableMailTransport = {
  send: (email: TransactionalEmail) => Promise<void>;
};

/**
 * Keep the provider seam tiny: tests can capture Mailpit mail, while the
 * production adapter can target Resend without leaking provider details into
 * domain commands. The intended production recipient is the configured
 * transactional-mail provider, not another Member or the browser client.
 */
export function createReplaceableMailTransport(
  send: (email: TransactionalEmail) => Promise<void>,
): ReplaceableMailTransport {
  return { send };
}

export type NoticeOutbox = {
  claim: (eventKey: string) => Promise<boolean>;
};

/** A deterministic local outbox used by unit and Mailpit-capture tests. */
export function createInMemoryNoticeOutbox(): NoticeOutbox & { entries: () => readonly string[] } {
  const claimed = new Set<string>();
  return {
    async claim(eventKey) {
      if (claimed.has(eventKey)) return false;
      claimed.add(eventKey);
      return true;
    },
    entries: () => [...claimed],
  };
}

/**
 * Claiming happens before provider I/O. An uncertain provider response is
 * therefore never replayed as a second product email after a worker restart.
 */
export function createAtMostOnceNoticeDispatcher({
  outbox,
  transport,
}: {
  outbox: NoticeOutbox;
  transport: ReplaceableMailTransport;
}) {
  return async function dispatch(notice: TransactionalNotice): Promise<boolean> {
    // Authentication-provider mail is deliberately outside the product
    // outbox, even when a runtime caller supplies a widened event value.
    if (!isPermittedTransactionalNotice(notice.type)
      || (AUTHENTICATION_NOTICE_TYPES as readonly string[]).includes(notice.type)) return false;
    if (!(await outbox.claim(notice.eventKey))) return false;
    await transport.send(renderTransactionalNoticeEmail(notice));
    return true;
  };
}

/** The scheduler-facing worker seam: drain queued rows until none remain. */
export function createTransactionalNoticeWorker({
  readQueued,
  dispatch,
  batchSize = 100,
}: {
  readQueued: () => Promise<TransactionalNotice | null>;
  dispatch: (notice: TransactionalNotice) => Promise<boolean>;
  batchSize?: number;
}) {
  return {
    async drain(): Promise<number> {
      let drained = 0;
      while (drained < batchSize) {
        const notice = await readQueued();
        if (!notice) break;
        await dispatch(notice);
        drained += 1;
      }
      return drained;
    },
  };
}
