import { describe, expect, it } from "vitest";

import {
  createAuthSessionAdapter,
  type AuthApi,
  type AuthSession,
  type MemberStorage,
} from "../src/worker/auth-session";

const session: AuthSession = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_at: 2_000,
  user: { id: "member-1", email: "member@example.test" },
};

function storageWith(values: Record<string, unknown> = {}): MemberStorage & { values: Record<string, unknown> } {
  return {
    values,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
    async clear() {
      for (const key of Object.keys(this.values)) delete this.values[key];
    },
  };
}

function authWith(overrides: Partial<AuthApi> = {}): AuthApi & {
  requested: string[];
  verified: string[];
  signOutCalls: number;
} {
  const state = {
    requested: [] as string[],
    verified: [] as string[],
    signOutCalls: 0,
  };
  return {
    requested: state.requested,
    verified: state.verified,
    get signOutCalls() { return state.signOutCalls; },
    getSession: async () => ({ data: { session: null }, error: null }),
    refreshSession: async () => ({ data: { session: null }, error: null }),
    signInWithOtp: async ({ email }) => {
      state.requested.push(email);
      return { data: {}, error: null };
    },
    verifyOtp: async ({ email, token }) => {
      state.verified.push(`${email}:${token}`);
      return { data: { session }, error: null };
    },
    signOut: async () => {
      state.signOutCalls += 1;
      return { error: null };
    },
    ...overrides,
  };
}

describe("service-worker-owned auth/session adapter", () => {
  it("requests an OTP without exposing account existence or a credential", async () => {
    const auth = authWith();
    const adapter = createAuthSessionAdapter({ auth, storage: storageWith(), now: () => 1_000 });

    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toEqual({
      status: "code_sent",
      resendAvailableAt: "1970-01-01T00:00:31.000Z",
    });
    expect(auth.requested).toEqual(["member@example.test"]);
  });

  it("enforces resend cooldown in worker-owned storage", async () => {
    const auth = authWith();
    const storage = storageWith({ "otp.cooldownUntil": 2_000 });
    const adapter = createAuthSessionAdapter({ auth, storage, now: () => 1_000 });

    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toEqual({
      status: "resend_cooldown",
      resendAvailableAt: "1970-01-01T00:00:02.000Z",
    });
    expect(auth.requested).toHaveLength(0);
  });

  it("locks concurrent OTP requests while the first request is in progress", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<{ data: unknown; error: null }>((resolve) => {
      release = () => resolve({ data: {}, error: null });
    });
    const auth = authWith({ signInWithOtp: async () => pending });
    const adapter = createAuthSessionAdapter({ auth, storage: storageWith() });
    const first = adapter.requestEmailOtp("member@example.test");

    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toEqual({ status: "requesting_code" });
    release();
    await expect(first).resolves.toMatchObject({ status: "code_sent" });
  });

  it("applies a generic per-destination OTP limit in addition to resend cooldown", async () => {
    const auth = authWith();
    let now = 1_000;
    const adapter = createAuthSessionAdapter({
      auth,
      storage: storageWith(),
      now: () => now,
      cooldownMs: 0,
      otpWindowMs: 10_000,
      maxOtpRequestsPerDestination: 2,
    });

    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toMatchObject({ status: "code_sent" });
    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toMatchObject({ status: "code_sent" });
    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toEqual({ status: "rate_limited", retryAfterSeconds: 30 });
    await expect(adapter.requestEmailOtp("other@example.test")).resolves.toMatchObject({ status: "code_sent" });
    now += 10_001;
    await expect(adapter.requestEmailOtp("member@example.test")).resolves.toMatchObject({ status: "code_sent" });
    expect(auth.requested).toEqual([
      "member@example.test",
      "member@example.test",
      "other@example.test",
      "member@example.test",
    ]);
  });

  it("distinguishes invalid, expired, rate-limited, and unavailable verification failures", async () => {
    const failures = [
      [{ status: 400, message: "Token is invalid" }, "invalid_code"],
      [{ status: 400, message: "Token has expired" }, "expired_code"],
      [{ status: 429, message: "Too many requests" }, "rate_limited"],
      [{ status: 503, message: "fetch failed" }, "service_unavailable"],
    ] as const;

    for (const [error, status] of failures) {
      const auth = authWith({
        verifyOtp: async () => ({ data: { session: null }, error }),
      });
      const adapter = createAuthSessionAdapter({ auth, storage: storageWith() });
      await expect(adapter.verifyEmailOtp("member@example.test", "123456")).resolves.toMatchObject({ status });
    }
  });

  it("refreshes an expired session once and restores the authenticated identity", async () => {
    let refreshCalls = 0;
    const auth = authWith({
      getSession: async () => ({ data: { session: { ...session, expires_at: 1_999 } }, error: null }),
      refreshSession: async () => {
        refreshCalls += 1;
        return { data: { session }, error: null };
      },
    });
    const adapter = createAuthSessionAdapter({ auth, storage: storageWith(), now: () => 2_000_000 });

    await expect(adapter.restoreSession()).resolves.toEqual({ status: "authenticated", session });
    expect(refreshCalls).toBe(1);
  });

  it("treats authoritative refresh rejection as signed out but preserves unavailable as unavailable", async () => {
    const rejected = authWith({
      getSession: async () => ({ data: { session: { ...session, expires_at: 1_999 } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { status: 401, message: "Invalid refresh token" } }),
    });
    await expect(createAuthSessionAdapter({ auth: rejected, storage: storageWith(), now: () => 2_000_000 }).restoreSession())
      .resolves.toEqual({ status: "signed_out" });

    const unavailable = authWith({
      getSession: async () => ({ data: { session: { ...session, expires_at: 1_999 } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { status: 503, message: "network unavailable" } }),
    });
    await expect(createAuthSessionAdapter({ auth: unavailable, storage: storageWith(), now: () => 2_000_000 }).restoreSession())
      .resolves.toEqual({ status: "service_unavailable" });
  });

  it("clears only the rejected session credential so pending recovery can survive reauth", async () => {
    const storage = storageWith({
      "auth-token": "session",
      "command.pending": { idempotencyKey: "pending" },
    });
    const rejected = authWith({
      getSession: async () => ({ data: { session: { ...session, expires_at: 1_999 } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { status: 401, message: "Invalid refresh token" } }),
    });
    await expect(createAuthSessionAdapter({ auth: rejected, storage, now: () => 2_000_000 }).restoreSession())
      .resolves.toEqual({ status: "signed_out" });
    expect(storage.values).toEqual({ "command.pending": { idempotencyKey: "pending" } });
  });

  it("clears the Supabase project storage key and in-memory session on refresh rejection", async () => {
    const storage = storageWith({
      "sb-project-host-auth-token": "session",
      "command.pending": { idempotencyKey: "pending" },
    });
    const auth = authWith({
      getSession: async () => ({ data: { session: { ...session, expires_at: 1_999 } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { status: 401, message: "Invalid refresh token" } }),
    });
    await expect(createAuthSessionAdapter({
      auth,
      storage,
      sessionStorageKey: "sb-project-host-auth-token",
      now: () => 2_000_000,
    }).restoreSession()).resolves.toEqual({ status: "signed_out" });
    expect(auth.signOutCalls).toBe(1);
    expect(storage.values).toEqual({ "command.pending": { idempotencyKey: "pending" } });
  });

  it("signs out locally and clears all member-owned storage", async () => {
    const auth = authWith();
    const storage = storageWith({
      "supabase.auth-token": "session",
      "member.displayName": "Member",
      "otp.cooldownUntil": 2_000,
    });
    const adapter = createAuthSessionAdapter({ auth, storage });

    await expect(adapter.signOut()).resolves.toEqual({ status: "signed_out" });
    expect(auth.signOutCalls).toBe(1);
    expect(storage.values).toEqual({});
  });
});
