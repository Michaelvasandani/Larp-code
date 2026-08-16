export type MemberAccount = {
  id: string;
  email: string;
  displayName: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
  adultConfirmedAt: string;
  consentAcceptedAt: string;
  consentVersion: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Structural validation shared by protocol ingress and the backend adapter. */
export function isMemberAccount(value: unknown): value is MemberAccount {
  if (!isRecord(value)) return false;
  const keys = [
    "id",
    "email",
    "displayName",
    "status",
    "createdAt",
    "updatedAt",
    "adultConfirmedAt",
    "consentAcceptedAt",
    "consentVersion",
  ] as const;
  return hasExactKeys(value, keys)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.email)
    && isNonEmptyString(value.displayName)
    && value.status === "active"
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.updatedAt)
    && isNonEmptyString(value.adultConfirmedAt)
    && isNonEmptyString(value.consentAcceptedAt)
    && isNonEmptyString(value.consentVersion);
}

