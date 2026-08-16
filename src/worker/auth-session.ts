import type { SignInState } from "../shared/protocol";
import { errorMessage, errorStatus, isUnavailable } from "./errors";

export type AuthErrorLike = {
  message: string;
  status?: number;
};

export type AuthSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: {
    id: string;
    email?: string;
  };
};

type AuthResult<T> = {
  data: T;
  error: AuthErrorLike | null;
};

export type AuthApi = {
  getSession: () => Promise<AuthResult<{ session: AuthSession | null }>>;
  refreshSession: () => Promise<AuthResult<{ session: AuthSession | null }>>;
  signInWithOtp: (input: {
    email: string;
    options: { shouldCreateUser: boolean };
  }) => Promise<AuthResult<unknown>>;
  verifyOtp: (input: {
    email: string;
    token: string;
    type: "email";
  }) => Promise<AuthResult<{ session: AuthSession | null }>>;
  signOut: () => Promise<{ error: AuthErrorLike | null }>;
};

export type MemberStorage = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  remove: (key: string) => Promise<void>;
  clear: () => Promise<void>;
};

export type RestoreSessionResult =
  | { status: "authenticated"; session: AuthSession }
  | { status: "signed_out" }
  | { status: "service_unavailable" };

export type VerifyEmailOtpResult = SignInState | { status: "authenticated"; session: AuthSession };

const COOLDOWN_KEY = "otp.cooldownUntil";
const DEFAULT_COOLDOWN_MS = 30_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRateLimited(error: unknown): boolean {
  return errorStatus(error) === 429 || /rate.?limit|too many requests/i.test(errorMessage(error));
}

function isExpiredCode(error: unknown): boolean {
  return /expired|already used|invalid or expired/i.test(errorMessage(error));
}

function availableAt(value: number): string {
  return new Date(value).toISOString();
}

function isExpiredSession(session: AuthSession, now: number): boolean {
  return typeof session.expires_at === "number" && session.expires_at * 1_000 <= now;
}

function classifyVerificationFailure(error: unknown): SignInState {
  if (isUnavailable(error)) return { status: "service_unavailable" };
  if (isRateLimited(error)) return { status: "rate_limited", retryAfterSeconds: 30 };
  return { status: isExpiredCode(error) ? "expired_code" : "invalid_code" };
}

export function createAuthSessionAdapter({
  auth,
  storage,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
}: {
  auth: AuthApi;
  storage: MemberStorage;
  now?: () => number;
  cooldownMs?: number;
}) {
  async function readCooldown(): Promise<number | null> {
    const value = await storage.get(COOLDOWN_KEY);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  let otpRequestInFlight = false;

  async function requestEmailOtp(emailInput: string): Promise<SignInState> {
    if (otpRequestInFlight) return { status: "requesting_code" };
    otpRequestInFlight = true;
    try {
      return await requestEmailOtpUnlocked(emailInput);
    } finally {
      otpRequestInFlight = false;
    }
  }

  async function requestEmailOtpUnlocked(emailInput: string): Promise<SignInState> {
    const email = emailInput.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return { status: "ready" };

    const cooldownUntil = await readCooldown();
    const currentTime = now();
    if (cooldownUntil !== null && cooldownUntil > currentTime) {
      return { status: "resend_cooldown", resendAvailableAt: availableAt(cooldownUntil) };
    }
    if (cooldownUntil !== null) await storage.remove(COOLDOWN_KEY);

    const setCooldown = async (currentTime: number): Promise<string> => {
      const resendAvailableAt = currentTime + cooldownMs;
      await storage.set(COOLDOWN_KEY, resendAvailableAt);
      return availableAt(resendAvailableAt);
    };
    const codeSent = async (currentTime: number): Promise<SignInState> => ({
      status: "code_sent",
      resendAvailableAt: await setCooldown(currentTime),
    });

    try {
      const { error } = await auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) {
        if (isUnavailable(error)) return { status: "service_unavailable" };
        if (isRateLimited(error)) {
          await setCooldown(currentTime);
          return { status: "rate_limited", retryAfterSeconds: 30 };
        }
        // Keep all account-related outcomes deliberately indistinguishable.
        return codeSent(currentTime);
      }
      return codeSent(currentTime);
    } catch (error) {
      if (isUnavailable(error)) return { status: "service_unavailable" };
      return codeSent(now());
    }
  }

  async function verifyEmailOtp(emailInput: string, token: string): Promise<VerifyEmailOtpResult> {
    const email = emailInput.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || !/^\d{6}$/.test(token)) return { status: "invalid_code" };
    try {
      const { data, error } = await auth.verifyOtp({ email, token, type: "email" });
      if (error) return classifyVerificationFailure(error);
      if (!data.session) return { status: "invalid_code" };
      return { status: "authenticated", session: data.session };
    } catch (error) {
      return classifyVerificationFailure(error);
    }
  }

  async function restoreSession(): Promise<RestoreSessionResult> {
    let result: AuthResult<{ session: AuthSession | null }>;
    try {
      result = await auth.getSession();
    } catch (error) {
      return isUnavailable(error) ? { status: "service_unavailable" } : { status: "signed_out" };
    }
    if (result.error) return isUnavailable(result.error)
      ? { status: "service_unavailable" }
      : { status: "signed_out" };
    if (!result.data.session) return { status: "signed_out" };

    if (!isExpiredSession(result.data.session, now())) {
      return { status: "authenticated", session: result.data.session };
    }

    try {
      const refreshed = await auth.refreshSession();
      if (refreshed.error) return isUnavailable(refreshed.error)
        ? { status: "service_unavailable" }
        : { status: "signed_out" };
      return refreshed.data.session
        ? { status: "authenticated", session: refreshed.data.session }
        : { status: "signed_out" };
    } catch (error) {
      return isUnavailable(error) ? { status: "service_unavailable" } : { status: "signed_out" };
    }
  }

  async function signOut(): Promise<{ status: "signed_out" }> {
    try {
      await auth.signOut();
    } catch {
      // Local storage is authoritative for this client; a remote sign-out failure
      // must not leave a reusable session or member state behind.
    } finally {
      await storage.clear();
    }
    return { status: "signed_out" };
  }

  return { requestEmailOtp, verifyEmailOtp, restoreSession, signOut };
}
