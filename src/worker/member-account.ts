import type { AuthSession } from "./auth-session";
import { isMemberAccount, type MemberAccount } from "../shared/member-account";

export { isMemberAccount };
export type { MemberAccount };

/** The consent copy and policy are versioned so a material change can require fresh consent. */
export const CONSENT_VERSION = "PRIV-031-v1" as const;
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 80;

export type MemberAccountIdentity = {
  userId: string;
  email: string;
};

export type MemberAccountRpc = {
  getMemberAccount: () => Promise<MemberAccount | null>;
  createMemberAccount: (input: {
    displayName: string;
    adultConfirmed: boolean;
    consentAccepted: boolean;
    consentVersion: typeof CONSENT_VERSION;
  }) => Promise<MemberAccount>;
};

export type MemberAccountSetup = {
  displayName: string;
  adultConfirmed: boolean;
  consentAccepted: boolean;
};

export type DisplayNameValidation = { value: string } | { error: string };

export function stripDisplayNameControlCharacters(value: string): string {
  // C0/C1 controls include line breaks, tabs, DEL, and invisible formatting bytes.
  return [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f));
  }).join("");
}

export function normalizeDisplayName(input: string): DisplayNameValidation {
  const value = stripDisplayNameControlCharacters(input).trim();
  if (value.length < DISPLAY_NAME_MIN_LENGTH) return { error: "Display name is required." };
  if (value.length > DISPLAY_NAME_MAX_LENGTH) {
    return { error: `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { value };
}

export function parseMemberAccount(value: unknown): MemberAccount {
  if (!isMemberAccount(value)) throw new Error("The backend returned an invalid Member Account.");
  if (value.consentVersion !== CONSENT_VERSION) throw new Error("The backend returned an invalid consent version.");
  return value;
}

function assertOwnAccount(account: MemberAccount, identity: MemberAccountIdentity): MemberAccount {
  if (account.id !== identity.userId || account.email.toLowerCase() !== identity.email.toLowerCase()) {
    throw new Error("The backend returned an unauthorized Member Account.");
  }
  return parseMemberAccount(account);
}

export function createMemberAccountAdapter({
  rpc,
  session,
}: {
  rpc: MemberAccountRpc;
  session: MemberAccountIdentity | AuthSession;
}) {
  const identity: MemberAccountIdentity = "userId" in session
    ? session
    : { userId: session.user.id, email: session.user.email ?? "" };

  async function getMemberAccount(): Promise<MemberAccount | null> {
    const account = await rpc.getMemberAccount();
    return account === null ? null : assertOwnAccount(account, identity);
  }

  async function createMemberAccount(setup: MemberAccountSetup): Promise<MemberAccount> {
    if (!setup.adultConfirmed || !setup.consentAccepted) {
      throw new Error("Adult confirmation and consent are required.");
    }
    const normalized = normalizeDisplayName(setup.displayName);
    if ("error" in normalized) throw new Error(normalized.error);
    const account = await rpc.createMemberAccount({
      displayName: normalized.value,
      adultConfirmed: true,
      consentAccepted: true,
      consentVersion: CONSENT_VERSION,
    });
    return assertOwnAccount(account, identity);
  }

  return { getMemberAccount, createMemberAccount };
}
