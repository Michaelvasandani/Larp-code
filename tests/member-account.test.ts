import { describe, expect, it } from "vitest";

import {
  CONSENT_VERSION,
  DISPLAY_NAME_MAX_LENGTH,
  createMemberAccountAdapter,
  normalizeDisplayName,
  type MemberAccount,
  type MemberAccountRpc,
} from "../src/worker/member-account";

const account: MemberAccount = {
  id: "member-1",
  email: "member@example.test",
  displayName: "Ada",
  status: "active",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  adultConfirmedAt: "2026-08-15T00:00:00.000Z",
  consentAcceptedAt: "2026-08-15T00:00:00.000Z",
  consentVersion: CONSENT_VERSION,
};

function rpcWith(overrides: Partial<MemberAccountRpc> = {}): MemberAccountRpc & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getMemberAccount() {
      calls.push("get");
      return null;
    },
    async createMemberAccount() {
      calls.push("create");
      return account;
    },
    ...overrides,
  };
}

describe("member account public boundary", () => {
  it("removes control characters, trims, and preserves safe text", () => {
    expect(normalizeDisplayName("  Ada\u0000\n Lovelace  ")).toEqual({ value: "Ada Lovelace" });
    expect(normalizeDisplayName("\u0000\u0009\u001f")).toEqual({ error: "Display name is required." });
    expect(normalizeDisplayName("x".repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toEqual({
      error: `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    });
  });

  it("reads only the account returned by the authenticated backend boundary", async () => {
    const rpc = rpcWith({ getMemberAccount: async () => {
      rpc?.calls.push("get");
      return account;
    } });
    const adapter = createMemberAccountAdapter({ rpc, session: { userId: account.id, email: account.email } });

    await expect(adapter.getMemberAccount()).resolves.toEqual(account);
    expect(rpc.calls).toEqual(["get"]);
  });

  it("rejects an account response bound to a different authenticated identity", async () => {
    const rpc = rpcWith({ getMemberAccount: async () => ({ ...account, id: "other-member" }) });
    const adapter = createMemberAccountAdapter({ rpc, session: { userId: account.id, email: account.email } });

    await expect(adapter.getMemberAccount()).rejects.toThrow("authorized Member Account");
  });

  it("requires affirmative adult and consent flags and sends the fixed policy version", async () => {
    const rpc = rpcWith();
    const adapter = createMemberAccountAdapter({ rpc, session: { userId: account.id, email: account.email } });

    await expect(adapter.createMemberAccount({
      displayName: "  Ada\n",
      adultConfirmed: true,
      consentAccepted: true,
    })).resolves.toEqual(account);
    expect(rpc.calls).toEqual(["create"]);
  });

  it("does not create an account when the authenticated backend rejects consent", async () => {
    const rpc = rpcWith({
      createMemberAccount: async () => {
        throw new Error("Adult confirmation and consent are required.");
      },
    });
    const adapter = createMemberAccountAdapter({ rpc, session: { userId: account.id, email: account.email } });

    await expect(adapter.createMemberAccount({
      displayName: "Ada",
      adultConfirmed: false,
      consentAccepted: true,
    })).rejects.toThrow("consent");
  });
});
