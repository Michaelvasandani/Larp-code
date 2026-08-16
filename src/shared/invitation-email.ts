export const INVITATION_EMAIL_SUBJECT = "You have a larp-code Invitation" as const;
export const INVITATION_EMAIL_DISCLAIMER = "This operational email contains no Challenge terms or progress. Sign in with the invited email to view the complete terms in larp-code." as const;

export type InvitationEmail = Readonly<{ subject: string; text: string }>;

export function sanitizeInviterDisplayName(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim() || "A Member";
}

/** Canonical template used by the worker boundary and the delivery function. */
export function renderInvitationEmail({ inviterDisplayName, invitationId }: {
  inviterDisplayName: string;
  invitationId: string;
}): InvitationEmail {
  const displayName = sanitizeInviterDisplayName(inviterDisplayName);
  return Object.freeze({
    subject: INVITATION_EMAIL_SUBJECT,
    text: `Hi,\n\n${displayName} invited you to larp-code.\n\n${INVITATION_EMAIL_DISCLAIMER}\n\nOpen larp-code and sign in with the invited email to view Invitation ${invitationId}.`,
  });
}
