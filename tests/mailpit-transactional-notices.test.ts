import { describe, expect, it } from "vitest";

import {
  createAtMostOnceNoticeDispatcher,
  createInMemoryNoticeOutbox,
  createReplaceableMailTransport,
  renderTransactionalNoticeEmail,
  type ProductNoticeType,
  type TransactionalNotice,
} from "../src/shared/transactional-notices";

const mailpitUrl = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const mailpitAvailable = await fetch(`${mailpitUrl}/api/v1/messages`).then((response) => response.ok).catch(() => false);
const mailpit = describe.skipIf(!mailpitAvailable)("real Mailpit Transactional Notice capture", () => {
  it("captures every permitted product event with its exact non-actor recipient and privacy boundary", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const types: ProductNoticeType[] = [
      "invitation", "invitation_accepted", "invitation_declined", "invitation_revoked",
      "challenge_canceled", "challenge_abandoned", "challenge_account_ended",
    ];
    const expected = types.map((type, index) => {
      const email = renderTransactionalNoticeEmail({
        eventKey: `${type}:${suffix}`,
        type,
        recipientEmail: `capture-${index}-${suffix}@example.test`,
        inviterDisplayName: "Capture Member",
        invitationId: type === "invitation" ? `invitation-${suffix}` : undefined,
        challengeId: type.startsWith("challenge") ? `challenge-${suffix}` : undefined,
      });
      return { type, email };
    });

    const sendToMailpit = async (email: ReturnType<typeof renderTransactionalNoticeEmail>) => {
      const sent = await fetch(`${mailpitUrl}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: { Email: "notice@auth.larp-code.example" },
          To: [{ Email: email.to }],
          Subject: email.subject,
          Text: email.text,
        }),
      });
      expect(sent.ok).toBe(true);
    };
    for (const { email } of expected) await sendToMailpit(email);

    // The same replaceable transport used by the edge adapter is exercised
    // against the real capture server so a retry cannot create a duplicate.
    const retryNotice: TransactionalNotice = {
      eventKey: `invitation:${suffix}:retry`,
      type: "invitation",
      recipientEmail: `retry-${suffix}@example.test`,
      inviterDisplayName: "Capture Member",
      invitationId: `retry-invitation-${suffix}`,
    };
    const outbox = createInMemoryNoticeOutbox();
    const dispatch = createAtMostOnceNoticeDispatcher({
      outbox,
      transport: createReplaceableMailTransport(sendToMailpit),
    });
    await expect(dispatch(retryNotice)).resolves.toBe(true);
    await expect(dispatch(retryNotice)).resolves.toBe(false);

    const forbiddenNotice = {
      ...retryNotice,
      eventKey: `challenge:${suffix}:completed`,
      type: "challenge_completed",
      recipientEmail: `forbidden-${suffix}@example.test`,
    } as unknown as TransactionalNotice;
    await expect(dispatch(forbiddenNotice)).resolves.toBe(false);

    const listing = await (await fetch(`${mailpitUrl}/api/v1/messages`)).json() as { messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }> };
    const captured = listing.messages.filter((message) => message.To.some(({ Address }) => Address.endsWith(`-${suffix}@example.test`)));
    expect(captured).toHaveLength(expected.length + 1);
    expect(captured.filter((message) => message.To[0]?.Address === retryNotice.recipientEmail)).toHaveLength(1);
    expect(captured.some((message) => message.To[0]?.Address === forbiddenNotice.recipientEmail)).toBe(false);
    for (const { email } of expected) {
      const message = captured.find((candidate) => candidate.To[0]?.Address === email.to);
      expect(message).toMatchObject({ Subject: email.subject });
      const detail = await (await fetch(`${mailpitUrl}/api/v1/message/${message!.ID}`)).json() as { Text: string };
      expect(detail.Text).toBe(email.text);
      expect(detail.Text).not.toMatch(/solve|pace|total|comparison|pet|blame|shame|urgent|hurry/i);
    }
    const retryMessage = captured.find((candidate) => candidate.To[0]?.Address === retryNotice.recipientEmail);
    expect(retryMessage).toMatchObject({ Subject: "You have a larp-code Invitation" });
    const retryDetail = await (await fetch(`${mailpitUrl}/api/v1/message/${retryMessage!.ID}`)).json() as { Text: string };
    expect(retryDetail.Text).toBe(renderTransactionalNoticeEmail(retryNotice).text);
  });
});

void mailpit;
