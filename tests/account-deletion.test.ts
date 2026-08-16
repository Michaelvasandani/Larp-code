import { describe, expect, it } from "vitest";

import {
  DELETE_MEMBER_ACCOUNT_COMMAND_KIND,
  DELETE_MEMBER_ACCOUNT_COMMAND_VERSION,
  createAccountDeletionAdapter,
  type AccountDeletionAuth,
  type AccountDeletionRpc,
} from "../src/worker/account-deletion";
import { PENDING_COMMAND_KEY, type PendingCommandStorage } from "../src/worker/command-recovery";
import type { MemberStorage } from "../src/worker/auth-session";

function storageWith(values: Record<string, unknown> = {}): MemberStorage & PendingCommandStorage & { values: Record<string, unknown>; clearCalls: number } {
  return {
    values,
    clearCalls: 0,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
    async clear() {
      for (const key of Object.keys(this.values)) delete this.values[key];
    },
  };
}

function authWith(overrides: Partial<AccountDeletionAuth> = {}): AccountDeletionAuth & { verifyCalls: string[]; signOutCalls: number } {
  const state = { verifyCalls: [] as string[], signOutCalls: 0 };
  return {
    verifyCalls: state.verifyCalls,
    get signOutCalls() { return state.signOutCalls; },
    async requestDeletionOtp() { return { error: null }; },
    async verifyDeletionOtp({ email, token }) {
      state.verifyCalls.push(`${email}:${token}`);
      return {
        data: { session: { access_token: "access", refresh_token: "refresh", user: { id: "member-1", email } } },
        error: null,
      };
    },
    async signOut() { state.signOutCalls += 1; return { error: null }; },
    ...overrides,
  };
}

function rpcWith(overrides: Partial<AccountDeletionRpc> = {}): AccountDeletionRpc & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async deleteMemberAccount(input) {
      calls.push(input.idempotencyKey);
      return { deletedMemberId: "deleted-member-1", deletedAt: "2026-08-16T00:00:00.000Z" };
    },
    ...overrides,
  };
}

describe("Member Account deletion command seam", () => {
  it("uses a distinct versioned destructive command", () => {
    expect(DELETE_MEMBER_ACCOUNT_COMMAND_KIND).toBe("delete_member_account");
    expect(DELETE_MEMBER_ACCOUNT_COMMAND_VERSION).toBe(2);
  });

  it("requires an explicit irreversible confirmation and a six-digit fresh OTP", async () => {
    const auth = authWith();
    const rpc = rpcWith();
    const adapter = createAccountDeletionAdapter({ auth, rpc, storage: storageWith() });
    const identity = { memberId: "member-1", memberEmail: "member@example.test" };

    await expect(adapter.deleteAccount({ confirmation: "delete my account", otp: "123456" }, identity))
      .resolves.toMatchObject({ status: "rejected", code: "validation" });
    await expect(adapter.deleteAccount({ confirmation: "DELETE MY ACCOUNT", otp: "12345" }, identity))
      .resolves.toMatchObject({ status: "rejected", code: "validation" });
    expect(auth.verifyCalls).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });

  it("verifies a fresh OTP, persists the exact deletion intent, and clears all local state after success", async () => {
    const storage = storageWith({
      [PENDING_COMMAND_KEY]: { stale: true },
      "supabase.auth.token": "session",
      "member.draft": "unfinished",
    });
    const auth = authWith();
    const rpc = rpcWith();
    const adapter = createAccountDeletionAdapter({ auth, rpc, storage, randomIdempotencyKey: () => "delete-key" });

    await expect(adapter.deleteAccount({ confirmation: "DELETE MY ACCOUNT", otp: "123456" }, {
      memberId: "member-1", memberEmail: "member@example.test",
    })).resolves.toMatchObject({ status: "applied", idempotencyKey: "delete-key" });
    expect(auth.verifyCalls).toEqual(["member@example.test:123456"]);
    expect(rpc.calls).toEqual(["delete-key"]);
    expect(storage.values).toEqual({});
    expect(auth.signOutCalls).toBe(1);
  });

  it("keeps one recoverable deletion key after an unknown result and retries that same key", async () => {
    const storage = storageWith();
    let attempts = 0;
    const rpc = rpcWith({
      async deleteMemberAccount(input) {
        rpc.calls.push(input.idempotencyKey);
        attempts += 1;
        if (attempts === 1) throw new Error("network timeout");
        return { deletedMemberId: "deleted-member-1", deletedAt: "2026-08-16T00:00:00.000Z", idempotencyKey: input.idempotencyKey };
      },
    });
    const auth = authWith();
    const adapter = createAccountDeletionAdapter({ auth, rpc, storage, randomIdempotencyKey: () => "delete-key" });
    const identity = { memberId: "member-1", memberEmail: "member@example.test" };

    await expect(adapter.deleteAccount({ confirmation: "DELETE MY ACCOUNT", otp: "123456" }, identity))
      .resolves.toMatchObject({ status: "uncertain", idempotencyKey: "delete-key" });
    expect(await storage.get(PENDING_COMMAND_KEY)).toMatchObject({
      kind: "delete_member_account",
      idempotencyKey: "delete-key",
      memberId: "member-1",
      intent: { confirmation: true },
    });
    await expect(adapter.recover(identity)).resolves.toMatchObject({ status: "applied", idempotencyKey: "delete-key" });
    expect(rpc.calls).toEqual(["delete-key", "delete-key"]);
    expect(storage.values).toEqual({});
  });

  it("does not send a deletion RPC when fresh OTP verification fails", async () => {
    const auth = authWith({
      async verifyDeletionOtp() {
        return { data: { session: null }, error: { status: 400, message: "Token is invalid" } };
      },
    });
    const rpc = rpcWith();
    const adapter = createAccountDeletionAdapter({ auth, rpc, storage: storageWith() });

    await expect(adapter.deleteAccount({ confirmation: "DELETE MY ACCOUNT", otp: "123456" }, {
      memberId: "member-1", memberEmail: "member@example.test",
    })).resolves.toMatchObject({ status: "rejected", code: "unauthorized" });
    expect(rpc.calls).toEqual([]);
  });

  it("erases local state when recovery authoritatively finds the account gone", async () => {
    const storage = storageWith({
      [PENDING_COMMAND_KEY]: {
        version: 1,
        kind: "delete_member_account",
        idempotencyKey: "delete-key",
        memberId: "member-1",
        memberEmail: "member@example.test",
        intent: { confirmation: true },
        requestedAt: "2026-08-16T00:00:00.000Z",
      },
      "supabase.auth.token": "stale-session",
      "member.draft": "private",
    });
    const auth = authWith();
    const rpc = rpcWith({
      async deleteMemberAccount() {
        throw { code: "42501", message: "A Member Account is required." };
      },
    });
    const adapter = createAccountDeletionAdapter({ auth, rpc, storage });

    await expect(adapter.recover({ memberId: "member-1", memberEmail: "member@example.test" }))
      .resolves.toMatchObject({ status: "rejected", code: "unauthorized" });
    expect(storage.values).toEqual({});
    expect(auth.signOutCalls).toBe(1);
  });
});
