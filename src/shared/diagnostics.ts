/** Short support references deliberately carry no account, email, or record identity. */
export const DIAGNOSTIC_ID_LENGTH = 10;
export const DIAGNOSTIC_ID_PATTERN = /^[0-9A-F]{10}$/;

export function createDiagnosticId(randomId: () => string = () => crypto.randomUUID()): string {
  return randomId().replaceAll("-", "").slice(0, DIAGNOSTIC_ID_LENGTH).toUpperCase();
}

export function isDiagnosticId(value: unknown): value is string {
  return typeof value === "string" && DIAGNOSTIC_ID_PATTERN.test(value);
}
