/** Shared worker-boundary error classification for auth and domain commands. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isUnavailable(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== undefined
    ? status >= 500
    : /fetch|network|connect|timeout|unavailable|failed to reach|load failed|socket|refused|reset|aborted/i.test(errorMessage(error));
}

export function isJwtAuthFailure(error: unknown): boolean {
  return errorCode(error) === "PGRST301" || /jwt|token.*expired|expired.*token/i.test(errorMessage(error));
}
