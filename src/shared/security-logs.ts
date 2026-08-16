import { isDiagnosticId } from "./diagnostics";

const FORBIDDEN_KEYS = new Set([
  "email", "memberemail", "recipientemail", "token", "accesstoken", "refreshtoken", "otp", "authcode", "verificationcode", "passcode",
  "solve", "solvecontent", "content", "snapshot", "completesnapshot", "partnerprogress", "petstate",
  "pet", "memberdata", "displayname", "invitationterms", "challengeprogress",
]);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key.replace(/[^a-z]/gi, "").toLowerCase());
}

function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 20).map(safeValue).filter((item) => item !== undefined);
  if (typeof value !== "object" || value === null) {
    if (typeof value !== "string") return value;
    if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) || /^\d{6}$/.test(value)) return undefined;
    return value.length > 200 ? value.slice(0, 200) : value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isForbiddenKey(key)) {
      const safe = safeValue(nested);
      if (safe !== undefined) result[key] = safe;
    }
  }
  return result;
}

export type PrivacyFilteredLog = Readonly<{
  event: string;
  diagnosticId?: string;
  details?: Record<string, unknown>;
}>;

/** Keep only operational event identity and explicitly safe diagnostic details. */
export function createPrivacyFilteredLog(input: Record<string, unknown>): PrivacyFilteredLog {
  const event = typeof input.event === "string" && input.event.length > 0 ? input.event : "unknown";
  const diagnosticId = isDiagnosticId(input.diagnosticId) ? input.diagnosticId : undefined;
  const detailsValue = safeValue(input.details);
  const details = typeof detailsValue === "object" && detailsValue !== null && !Array.isArray(detailsValue)
    ? detailsValue as Record<string, unknown>
    : undefined;
  return Object.freeze({
    event,
    ...(diagnosticId ? { diagnosticId } : {}),
    ...(details && Object.keys(details).length ? { details } : {}),
  });
}

export function isPrivacySafeLog(value: unknown): value is PrivacyFilteredLog {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!Object.keys(row).every((key) => key === "event" || key === "diagnosticId" || key === "details")) return false;
  if (typeof row.event !== "string" || row.event.length === 0) return false;
  if (row.diagnosticId !== undefined && !isDiagnosticId(row.diagnosticId)) return false;
  if (row.details === undefined) return true;
  if (typeof row.details !== "object" || row.details === null || Array.isArray(row.details)) return false;
  return JSON.stringify(safeValue(row.details)) === JSON.stringify(row.details);
}
