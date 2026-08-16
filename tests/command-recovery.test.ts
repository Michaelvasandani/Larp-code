import { describe, expect, it } from "vitest";

import {
  createDisplayNameCommandAdapter,
  createPendingCommandStore,
  PENDING_COMMAND_KEY,
  type PendingCommandStorage,
} from "../src/worker/command-recovery";
import { TRANSACTION_COMMAND_VERSION, type MemberAccount, type PendingCommand } from "../src/shared/protocol";

const account: MemberAccount = {
  id: "member-1",
  email: "member@example.test",
  displayName: "Ada",
  status: "active",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
  adultConfirmedAt: "2026-08-15T00:00:00.000Z",
  consentAcceptedAt: "2026-08-15T00:00:00.000Z",
  consentVersion: "PRIV-031-v1",
};

function storageWith(values: Record<string, unknown> = {}): PendingCommandStorage & { values: Record<string, unknown> } {
  return {
    values,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
  };
}

const identity = { memberId: account.id, memberEmail: account.email };

type DisplayNamePendingCommand = Extract<PendingCommand, { kind: "update_display_name" }>;

function pending(overrides: Partial<DisplayNamePendingCommand> = {}): DisplayNamePendingCommand {
  return {
    version: TRANSACTION_COMMAND_VERSION,
    kind: "update_display_name",
    idempotencyKey: "key-1",
    memberId: account.id,
    memberEmail: account.email,
    intent: { displayName: "Grace" },
    requestedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("recoverable transactional command seam", () => {
  it("stores at most one account-bound pending command", async () => {
    const storage = storageWith();
    const commands = createPendingCommandStore(storage);

    await commands.persist(pending());
    await expect(commands.persist(pending({ idempotencyKey: "key-2" })))
      .rejects.toThrow("already awaiting recovery");
    await expect(commands.read()).resolves.toMatchObject({ idempotencyKey: "key-1" });
  });

  it("serializes stores sharing one durable storage boundary", async () => {
    const storage = storageWith();
    const firstStore = createPendingCommandStore(storage);
    const secondStore = createPendingCommandStore(storage);

    await Promise.all([
      firstStore.persist(pending()),
      secondStore.persist(pending({ idempotencyKey: "key-2" })),
    ].map((operation) => operation.catch(() => undefined)));

    await expect(firstStore.read()).resolves.toMatchObject({ idempotencyKey: "key-1" });
    await expect(secondStore.read()).resolves.toMatchObject({ idempotencyKey: "key-1" });
  });

  it("persists intent before sending and clears it only after the stored result arrives", async () => {
    const storage = storageWith();
    const calls: string[] = [];
    const adapter = createDisplayNameCommandAdapter({
      storage,
      randomIdempotencyKey: () => "key-1",
      rpc: {
        async updateDisplayName(input) {
          expect(storage.values[PENDING_COMMAND_KEY]).toMatchObject({
            idempotencyKey: "key-1",
            memberId: account.id,
            intent: { displayName: "Grace" },
          });
          calls.push(input.idempotencyKey);
          return { ...account, displayName: "Grace" };
        },
      },
    });

    await expect(adapter.updateDisplayName("  Grace\n", identity)).resolves.toMatchObject({
      status: "applied",
      idempotencyKey: "key-1",
      account: { displayName: "Grace" },
    });
    expect(calls).toEqual(["key-1"]);
    await expect(adapter.readPending()).resolves.toBeNull();
  });

  it("reports uncertainty and keeps the same key when the response is lost", async () => {
    const storage = storageWith();
    const adapter = createDisplayNameCommandAdapter({
      storage,
      randomIdempotencyKey: () => "key-1",
      rpc: { updateDisplayName: async () => { throw new Error("network timeout"); } },
    });

    await expect(adapter.updateDisplayName("Grace", identity)).resolves.toEqual({
      status: "uncertain",
      kind: "update_display_name",
      idempotencyKey: "key-1",
      message: "Checking whether this completed.",
    });
    await expect(adapter.readPending()).resolves.toMatchObject({ idempotencyKey: "key-1" });
  });

  it("retries the stored key after uncertainty and clears it only after the replay result", async () => {
    const storage = storageWith();
    const keys: string[] = [];
    let attempts = 0;
    const adapter = createDisplayNameCommandAdapter({
      storage,
      randomIdempotencyKey: () => "key-1",
      rpc: {
        async updateDisplayName(input) {
          keys.push(input.idempotencyKey);
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return { ...account, displayName: "Grace" };
        },
      },
    });

    await expect(adapter.updateDisplayName("Grace", identity)).resolves.toMatchObject({ status: "uncertain" });
    await expect(adapter.recover(identity)).resolves.toMatchObject({ status: "applied", idempotencyKey: "key-1" });
    expect(keys).toEqual(["key-1", "key-1"]);
    await expect(adapter.readPending()).resolves.toBeNull();
  });

  it("replays only for the originating Member and clears instead of replaying for another account", async () => {
    const storage = storageWith({ [PENDING_COMMAND_KEY]: pending() });
    let calls = 0;
    const adapter = createDisplayNameCommandAdapter({
      storage,
      rpc: {
        async updateDisplayName() {
          calls += 1;
          return { ...account, displayName: "Grace" };
        },
      },
    });

    await expect(adapter.recover({ memberId: "member-2", memberEmail: "other@example.test" })).resolves.toBeNull();
    expect(calls).toBe(0);
    await expect(adapter.readPending()).resolves.toBeNull();
  });

  it("returns a typed validation outcome without retaining a command that cannot run", async () => {
    const storage = storageWith();
    const adapter = createDisplayNameCommandAdapter({
      storage,
      rpc: { updateDisplayName: async () => ({ ...account, displayName: "never" }) },
    });

    await expect(adapter.updateDisplayName("\u0000\n", identity)).resolves.toEqual({
      status: "rejected",
      code: "validation",
      message: "Display name is required.",
    });
    await expect(adapter.readPending()).resolves.toBeNull();
  });

  it("treats Supabase JWT expiry as a known authorization outcome", async () => {
    const storage = storageWith();
    const adapter = createDisplayNameCommandAdapter({
      storage,
      rpc: {
        async updateDisplayName() {
          throw { code: "PGRST301", message: "JWT expired" };
        },
      },
    });

    await expect(adapter.updateDisplayName("Grace", identity)).resolves.toEqual({
      status: "rejected",
      code: "unauthorized",
      message: "JWT expired",
    });
    await expect(adapter.readPending()).resolves.toBeNull();
  });
});
