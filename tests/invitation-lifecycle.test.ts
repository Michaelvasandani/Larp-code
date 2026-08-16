import { describe, expect, it } from "vitest";

import {
  createInvitationTerminalCommandAdapter,
  effectiveInvitationStatus,
  invitationActionsForRole,
  type InvitationRecord,
} from "../src/worker/invitation";
import { isPopupRequest, isPopupResponse, PROTOCOL_VERSION } from "../src/shared/protocol";
import { PENDING_COMMAND_KEY, type PendingCommandStorage } from "../src/worker/command-recovery";

const pendingInvitation: InvitationRecord = {
  id: "invitation-1",
  inviterId: "member-1",
  inviterDisplayName: "Owner",
  invitedEmail: "friend@example.test",
  timeZone: "America/Los_Angeles",
  startDate: "2026-08-16",
  deadlineDate: "2026-09-14",
  problemSetVersionId: "version-a",
  status: "pending",
  createdAt: "2026-08-15T00:00:00.000Z",
};

function storageWith(values: Record<string, unknown> = {}): PendingCommandStorage & { values: Record<string, unknown> } {
  return {
    values,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
  };
}

describe("Invitation terminal command boundary", () => {
  it("persists a revoke before sending and retries the same idempotency key", async () => {
    const storage = storageWith();
    const keys: string[] = [];
    let attempts = 0;
    const adapter = createInvitationTerminalCommandAdapter({
      storage,
      randomIdempotencyKey: () => "revoke-key",
      rpc: {
        async revokeInvitation(input) {
          expect(storage.values[PENDING_COMMAND_KEY]).toMatchObject({
            kind: "revoke_invitation",
            intent: { invitationId: "invitation-1" },
          });
          keys.push(input.idempotencyKey);
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return {
            ...pendingInvitation,
            status: "revoked" as const,
            terminalActorId: "member-1",
            terminalAt: "2026-08-15T01:00:00.000Z",
          };
        },
      },
    });

    const first = await adapter.revokeInvitation("invitation-1", {
      memberId: "member-1",
      memberEmail: "owner@example.test",
    });
    expect(first.status).toBe("uncertain");
    expect(await adapter.recover({ memberId: "member-1", memberEmail: "owner@example.test" })).toMatchObject({
      status: "applied",
      idempotencyKey: "revoke-key",
      invitation: { status: "revoked", terminalActorId: "member-1" },
    });
    expect(keys).toEqual(["revoke-key", "revoke-key"]);
    expect(await adapter.readPending()).toBeNull();
  });

  it("keeps a declined command recoverable when the backend is temporarily unavailable", async () => {
    const storage = storageWith();
    let attempts = 0;
    const adapter = createInvitationTerminalCommandAdapter({
      storage,
      randomIdempotencyKey: () => "decline-key",
      rpc: {
        async declineInvitation() {
          attempts += 1;
          if (attempts === 1) throw new Error("connection reset");
          return {
            ...pendingInvitation,
            status: "declined" as const,
            terminalActorId: "member-2",
            terminalAt: "2026-08-15T01:00:00.000Z",
          };
        },
      },
    });

    await expect(adapter.declineInvitation("invitation-1", {
      memberId: "member-2",
      memberEmail: "friend@example.test",
    })).resolves.toMatchObject({ status: "uncertain" });
    expect(await adapter.recover({ memberId: "member-2", memberEmail: "friend@example.test" })).toMatchObject({
      status: "applied",
      invitation: { status: "declined" },
    });
  });

  it("derives authoritative expiration at the Challenge Time Zone start boundary", () => {
    expect(effectiveInvitationStatus(pendingInvitation, "2026-08-16T06:59:59.999Z")).toBe("pending");
    expect(effectiveInvitationStatus(pendingInvitation, "2026-08-16T07:00:00.000Z")).toBe("expired");
    expect(effectiveInvitationStatus({ ...pendingInvitation, status: "revoked" }, "2026-08-17T00:00:00.000Z")).toBe("revoked");
  });

  it("exposes only role-authorized actions and no actions for terminal invitations", () => {
    expect(invitationActionsForRole("inviter", pendingInvitation)).toEqual(["revoke"]);
    expect(invitationActionsForRole("invitee", pendingInvitation)).toEqual(["accept", "decline"]);
    expect(invitationActionsForRole("inviter", { ...pendingInvitation, status: "expired" })).toEqual([]);
    expect(invitationActionsForRole("invitee", { ...pendingInvitation, status: "declined" })).toEqual([]);
  });

  it("accepts terminal action requests and terminal role snapshots at the protocol seam", () => {
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "revoke_invitation", invitationId: "invitation-1" })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "decline_invitation", invitationId: "invitation-1" })).toBe(true);
    const snapshot = {
      contractVersion: PROTOCOL_VERSION,
      kind: "invitation" as const,
      authoritativeServerTime: "2026-08-16T07:00:00.000Z",
      freshness: { revision: "r1", fetchedAt: "2026-08-16T07:00:00.000Z" },
      compatibility: { minimumClientVersion: "0.1.0" },
      backend: { status: "reachable" as const, schemaVersion: 5 },
      worker: { bootId: "boot-1", bootCount: 1, sessionRestoredFromStorage: true },
      invitation: { ...pendingInvitation, status: "expired" as const, terminalAt: "2026-08-16T07:00:00.000Z" },
      role: "invitee" as const,
      actions: [] as const,
    };
    expect(isPopupResponse({ ok: true, snapshot })).toBe(true);
  });
});
