import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_NOTICE_TYPES,
  TRANSACTIONAL_NOTICE_MATRIX,
  createAtMostOnceNoticeDispatcher,
  createInMemoryNoticeOutbox,
  createReplaceableMailTransport,
  createTransactionalNoticeWorker,
  isPermittedTransactionalNotice,
  noticeRecipient,
  renderAuthenticationCodeEmail,
  renderTransactionalNoticeEmail,
  type TransactionalNotice,
} from "../src/shared/transactional-notices";

const invitationNotice: TransactionalNotice = {
  eventKey: "invitation:invitation-1:created",
  type: "invitation",
  recipientEmail: "invitee@example.test",
  inviterDisplayName: "Ada",
  invitationId: "invitation-1",
};

describe("Transactional Notice matrix", () => {
  it("contains only the permitted one-time operational events and explicit recipients", () => {
    expect(TRANSACTIONAL_NOTICE_MATRIX.map((entry) => entry.type)).toEqual([
      "sign_in_code",
      "account_security",
      "invitation",
      "invitation_accepted",
      "invitation_declined",
      "invitation_revoked",
      "challenge_canceled",
      "challenge_abandoned",
      "challenge_account_ended",
    ]);
    for (const forbidden of [
      "invitation_expired",
      "invitation_automatic_activation",
      "challenge_deadline",
      "challenge_completed",
      "challenge_incomplete",
      "solve",
      "solve_correction",
      "pace_status",
      "pet_condition",
      "evolution_stage",
    ]) {
      expect(isPermittedTransactionalNotice(forbidden)).toBe(false);
    }
  });

  it("keeps OTP transport separate while allowing no other authentication payload", () => {
    expect(AUTHENTICATION_NOTICE_TYPES).toEqual(["sign_in_code", "account_security"]);
    const email = renderAuthenticationCodeEmail({ token: "123456" });
    expect(email.text).toContain("123456");
    expect(email.tracking).toBe(false);
    expect(() => renderAuthenticationCodeEmail({ token: "secret-token" })).toThrow(/six-digit/);
  });

  it("returns no product email for the actor and addresses only the non-actor", () => {
    expect(noticeRecipient("invitation_accepted", {
      actorMemberId: "invitee-1",
      inviterMemberId: "inviter-1",
      inviterEmail: "inviter@example.test",
      inviteeEmail: "invitee@example.test",
    })).toEqual({ memberId: "inviter-1", email: "inviter@example.test" });
    expect(noticeRecipient("invitation_accepted", {
      actorMemberId: "inviter-1",
      inviterMemberId: "inviter-1",
      inviterEmail: "inviter@example.test",
      inviteeEmail: "invitee@example.test",
    })).toBeNull();
    expect(noticeRecipient("challenge_canceled", {
      actorMemberId: "member-1",
      memberId: "member-1",
      otherMemberId: "member-2",
      otherMemberEmail: "other@example.test",
    })).toEqual({ memberId: "member-2", email: "other@example.test" });
    expect(noticeRecipient("challenge_abandoned", {
      actorMemberId: "member-1",
      otherMemberId: "member-2",
      otherMemberEmail: "other@example.test",
    })).toEqual({ memberId: "member-2", email: "other@example.test" });
    expect(noticeRecipient("challenge_account_ended", {
      actorMemberId: "deleted-member",
      otherMemberId: "member-2",
      otherMemberEmail: "other@example.test",
    })).toEqual({ memberId: "member-2", email: "other@example.test" });
  });

  it("renders privacy-minimal copy without progress, Pet, blame, or artificial urgency", () => {
    const types = [
      "invitation",
      "invitation_accepted",
      "invitation_declined",
      "invitation_revoked",
      "challenge_canceled",
      "challenge_abandoned",
      "challenge_account_ended",
    ] as const;
    for (const type of types) {
      const email = renderTransactionalNoticeEmail({
        ...invitationNotice,
        type,
        eventKey: `${type}:event-1`,
        challengeId: "challenge-1",
      });
      expect(email.tracking).toBe(false);
      expect(email.text).not.toMatch(/solve|pace|total|comparison|pet|blame|shame|urgent|hurry/i);
      expect(email.text).toContain("Sign in to larp-code");
    }
  });
});

describe("Transactional Notice outbox seam", () => {
  it("drains queued permitted rows through the scheduler-facing worker seam", async () => {
    const queued = [
      invitationNotice,
      { ...invitationNotice, eventKey: "invitation:invitation-2:created", invitationId: "invitation-2" },
    ];
    const seen: string[] = [];
    const worker = createTransactionalNoticeWorker({
      readQueued: async () => queued.shift() ?? null,
      dispatch: async (notice) => { seen.push(notice.eventKey); return true; },
    });
    await expect(worker.drain()).resolves.toBe(2);
    expect(seen).toEqual(["invitation:invitation-1:created", "invitation:invitation-2:created"]);
  });

  it("dispatches a claimed event at most once across retries", async () => {
    const outbox = createInMemoryNoticeOutbox();
    const sent: string[] = [];
    const transport = createReplaceableMailTransport(async (email) => { sent.push(email.subject); });
    const dispatch = createAtMostOnceNoticeDispatcher({ outbox, transport });

    await expect(dispatch(invitationNotice)).resolves.toBe(true);
    await expect(dispatch(invitationNotice)).resolves.toBe(false);
    expect(sent).toHaveLength(1);
    expect(outbox.entries()).toHaveLength(1);
  });

  it("does not retry a claimed event after an uncertain provider result", async () => {
    const outbox = createInMemoryNoticeOutbox();
    let attempts = 0;
    const transport = createReplaceableMailTransport(async () => {
      attempts += 1;
      throw new Error("provider timeout after accept");
    });
    const dispatch = createAtMostOnceNoticeDispatcher({ outbox, transport });

    await expect(dispatch(invitationNotice)).rejects.toThrow("provider timeout");
    await expect(dispatch(invitationNotice)).resolves.toBe(false);
    expect(attempts).toBe(1);
  });
});
