import { describe, expect, it } from "vitest";

import {
  createInvitationCommandAdapter,
  INVITATION_COMMAND_KIND,
  INVITATION_COMMAND_VERSION,
  INVITATION_EMAIL_DISCLAIMER,
  normalizeInvitationTerms,
  renderInvitationEmail,
  type InvitationTermsInput,
} from "../src/worker/invitation";
import { PENDING_COMMAND_KEY, type PendingCommandStorage } from "../src/worker/command-recovery";

const valid: InvitationTermsInput = {
  invitedEmail: "  Friend@Example.test ",
  timeZone: "America/Los_Angeles",
  startDate: "2026-08-16",
  deadlineDate: "2026-09-14",
};

function storageWith(values: Record<string, unknown> = {}): PendingCommandStorage & { values: Record<string, unknown> } {
  return {
    values,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
  };
}

describe("Invitation public command boundary", () => {
  it("normalizes one email and preserves an inclusive future schedule", () => {
    expect(normalizeInvitationTerms(valid, "2026-08-15T23:00:00.000Z")).toEqual({
      value: {
        invitedEmail: "friend@example.test",
        timeZone: "America/Los_Angeles",
        startDate: "2026-08-16",
        deadlineDate: "2026-09-14",
      },
    });
  });

  it("rejects invalid IANA zones, reversed dates, and a start before tomorrow in that zone", () => {
    expect(normalizeInvitationTerms({ ...valid, timeZone: "Not/AZone" }, "2026-08-15T23:00:00.000Z"))
      .toEqual({ error: "Choose a valid IANA Challenge Time Zone." });
    expect(normalizeInvitationTerms({ ...valid, startDate: "2026-08-15" }, "2026-08-15T23:00:00.000Z"))
      .toEqual({ error: "Start Date must be the next calendar day or later in the Challenge Time Zone." });
    expect(normalizeInvitationTerms({ ...valid, deadlineDate: "2026-08-15" }, "2026-08-15T23:00:00.000Z"))
      .toEqual({ error: "Deadline Date must be on or after Start Date." });
  });

  it("uses a minimal operational email that requires authentication for terms", () => {
    const email = renderInvitationEmail({ inviterDisplayName: "Ada", invitationId: "invitation-1" });
    expect(email.subject).toBe("You have a larp-code Invitation");
    expect(email.text).toContain("Ada invited you to larp-code.");
    expect(email.text).toContain("Sign in with the invited email to view the complete terms");
    expect(email.text).toContain(INVITATION_EMAIL_DISCLAIMER);
    expect(email.text).toContain("Invitation invitation-1");
    expect(email.text).not.toContain("Deadline");
    expect(email.text).not.toContain("Time Zone");
  });

  it("keeps the recoverable command identity versioned", () => {
    expect(INVITATION_COMMAND_KIND).toBe("create_invitation");
    expect(INVITATION_COMMAND_VERSION).toBe(2);
  });

  it("persists the complete invitation intent before sending and retries the same key", async () => {
    const storage = storageWith();
    const keys: string[] = [];
    let attempts = 0;
    let deliveries = 0;
    const adapter = createInvitationCommandAdapter({
      storage,
      randomIdempotencyKey: () => "invite-key",
      rpc: {
        async createInvitation(input) {
          expect(storage.values[PENDING_COMMAND_KEY]).toMatchObject({
            kind: "create_invitation",
            intent: { invitedEmail: "friend@example.test", problemSetVersionId: "version-a" },
          });
          keys.push(input.idempotencyKey);
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return {
            id: "invitation-1",
            inviterId: "member-1",
            inviterDisplayName: "Owner",
            ...valid,
            invitedEmail: "friend@example.test",
            problemSetVersionId: "version-a",
            status: "pending",
            createdAt: "2026-08-15T00:00:00.000Z",
          };
        },
        async dispatchInvitationNotice(invitationId) {
          expect(invitationId).toBe("invitation-1");
          deliveries += 1;
        },
      },
    });

    const first = await adapter.createInvitation(valid, {
      memberId: "member-1",
      memberEmail: "owner@example.test",
    }, "version-a", "2026-08-15T23:00:00.000Z");
    expect(first.status).toBe("uncertain");
    expect(await adapter.recover({ memberId: "member-1", memberEmail: "owner@example.test" })).toMatchObject({
      status: "applied",
      idempotencyKey: "invite-key",
    });
    expect(keys).toEqual(["invite-key", "invite-key"]);
    expect(deliveries).toBe(1);
    expect(await adapter.readPending()).toBeNull();
  });

  it("keeps the invitation pending when delivery is uncertain and retries dispatch", async () => {
    const storage = storageWith();
    let deliveryAttempts = 0;
    let commandAttempts = 0;
    const adapter = createInvitationCommandAdapter({
      storage,
      randomIdempotencyKey: () => "invite-delivery-key",
      rpc: {
        async createInvitation() {
          commandAttempts += 1;
          return {
            id: "invitation-delivery",
            inviterId: "member-1",
            inviterDisplayName: "Owner",
            ...valid,
            invitedEmail: "friend@example.test",
            problemSetVersionId: "version-a",
            status: "pending" as const,
            createdAt: "2026-08-15T00:00:00.000Z",
          };
        },
        async dispatchInvitationNotice() {
          deliveryAttempts += 1;
          if (deliveryAttempts === 1) throw new Error("network timeout");
        },
      },
    });

    await expect(adapter.createInvitation(valid, {
      memberId: "member-1", memberEmail: "owner@example.test",
    }, "version-a", "2026-08-15T23:00:00.000Z")).resolves.toMatchObject({ status: "uncertain" });
    expect(await adapter.readPending()).toMatchObject({ idempotencyKey: "invite-delivery-key" });
    await expect(adapter.recover({ memberId: "member-1", memberEmail: "owner@example.test" })).resolves.toMatchObject({ status: "applied" });
    expect(commandAttempts).toBe(2);
    expect(deliveryAttempts).toBe(2);
    expect(await adapter.readPending()).toBeNull();
  });

  it("returns a typed rate-limit outcome and leaves no replayable write", async () => {
    const storage = storageWith();
    const adapter = createInvitationCommandAdapter({
      storage,
      rpc: { createInvitation: async () => { throw { status: 429, message: "Too many Invitations" }; } },
    });
    await expect(adapter.createInvitation(valid, {
      memberId: "member-1", memberEmail: "owner@example.test",
    }, "version-a", "2026-08-15T23:00:00.000Z")).resolves.toMatchObject({
      status: "rejected",
      code: "rate_limited",
    });
    expect(await adapter.readPending()).toBeNull();
  });
});
