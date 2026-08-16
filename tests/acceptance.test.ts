import { describe, expect, it } from "vitest";

import {
  ACCEPT_INVITATION_COMMAND_KIND,
  ACCEPT_INVITATION_COMMAND_VERSION,
  createAcceptInvitationCommandAdapter,
  type AcceptanceInvitation,
} from "../src/worker/acceptance";
import { PENDING_COMMAND_KEY, type PendingCommandStorage } from "../src/worker/command-recovery";

const invitation: AcceptanceInvitation = {
  id: "invitation-1",
  inviterId: "member-1",
  inviterDisplayName: "Ada",
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

describe("accept Invitation command seam", () => {
  it("uses a distinct versioned command kind", () => {
    expect(ACCEPT_INVITATION_COMMAND_KIND).toBe("accept_invitation");
    expect(ACCEPT_INVITATION_COMMAND_VERSION).toBe(2);
  });

  it("denies an authenticated identity whose email does not match before persisting a command", async () => {
    const storage = storageWith();
    let calls = 0;
    const adapter = createAcceptInvitationCommandAdapter({
      storage,
      rpc: { async acceptInvitation() { calls += 1; throw new Error("must not run"); } },
    });

    await expect(adapter.acceptInvitation(invitation, {
      memberId: "member-2",
      memberEmail: "outsider@example.test",
    })).resolves.toEqual({
      status: "rejected",
      kind: "accept_invitation",
      code: "unauthorized",
      message: "Sign in with the invited email to accept this Invitation.",
    });
    expect(calls).toBe(0);
    expect(await storage.get(PENDING_COMMAND_KEY)).toBeNull();
  });

  it("persists the invitation id before sending and retries the same key after uncertainty", async () => {
    const storage = storageWith();
    const keys: string[] = [];
    let attempts = 0;
    const adapter = createAcceptInvitationCommandAdapter({
      storage,
      randomIdempotencyKey: () => "accept-key",
      rpc: {
        async acceptInvitation(input) {
          expect(storage.values[PENDING_COMMAND_KEY]).toMatchObject({
            kind: "accept_invitation",
            intent: { invitationId: "invitation-1" },
          });
          keys.push(input.idempotencyKey);
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return {
            id: "challenge-1",
            invitationId: invitation.id,
            timeZone: invitation.timeZone,
            startDate: invitation.startDate,
            deadlineDate: invitation.deadlineDate,
            problemSetVersionId: invitation.problemSetVersionId,
            status: "scheduled" as const,
            createdAt: "2026-08-15T00:00:00.000Z",
            members: [
              { memberId: "member-1", email: "ada@example.test", displayName: "Ada", authority: "equal" as const },
              { memberId: "member-2", email: invitation.invitedEmail, displayName: "Grace", authority: "equal" as const },
            ],
          };
        },
      },
    });
    const identity = { memberId: "member-2", memberEmail: invitation.invitedEmail };

    await expect(adapter.acceptInvitation(invitation, identity)).resolves.toMatchObject({
      status: "uncertain",
      kind: "accept_invitation",
      idempotencyKey: "accept-key",
    });
    await expect(adapter.recover(identity)).resolves.toMatchObject({
      status: "applied",
      idempotencyKey: "accept-key",
      challenge: { id: "challenge-1", status: "scheduled" },
    });
    expect(keys).toEqual(["accept-key", "accept-key"]);
    expect(await storage.get(PENDING_COMMAND_KEY)).toBeNull();
  });

  it("returns a typed stale or capacity rejection and clears the replay envelope", async () => {
    const storage = storageWith();
    const adapter = createAcceptInvitationCommandAdapter({
      storage,
      rpc: { async acceptInvitation() { throw { code: "P0003", message: "The Invitation is no longer pending or a Member has another Committed Challenge." }; } },
    });

    await expect(adapter.acceptInvitation(invitation, {
      memberId: "member-2", memberEmail: invitation.invitedEmail,
    })).resolves.toMatchObject({
      status: "rejected",
      code: "validation",
      message: "The Invitation is no longer pending or a Member has another Committed Challenge.",
    });
    expect(await storage.get(PENDING_COMMAND_KEY)).toBeNull();
  });
});
