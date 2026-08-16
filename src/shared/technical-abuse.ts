export const TECHNICAL_ABUSE_REASONS = [
  "credential_stuffing",
  "token_replay",
  "authorization_bypass",
  "automated_request_flood",
  "security_vulnerability",
] as const;

export type TechnicalAbuseReason = (typeof TECHNICAL_ABUSE_REASONS)[number];

export function isTechnicalAbuseReason(value: unknown): value is TechnicalAbuseReason {
  return typeof value === "string" && (TECHNICAL_ABUSE_REASONS as readonly string[]).includes(value);
}
