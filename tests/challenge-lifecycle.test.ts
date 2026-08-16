import { describe, expect, it, vi } from "vitest";

import {
  CANCEL_CHALLENGE_COMMAND_KIND,
  createChallengeLifecycleCommandAdapter,
  effectiveChallengeStatus,
  challengeActionsForStatus,
  type ChallengeRecord,
} from "../src/worker/challenge";
import { PENDING_COMMAND_KEY, type PendingCommandStorage } from "../src/worker/command-recovery";
import { isPopupRequest, isPopupResponse, PROTOCOL_VERSION } from "../src/shared/protocol";
import { dateInTimeZone } from "../src/shared/timezone";

const scheduled: ChallengeRecord = {
  id: "challenge-1",
  invitationId: "invitation-1",
  timeZone: "America/Los_Angeles",
  startDate: "2026-08-16",
  deadlineDate: "2026-09-14",
  problemSetVersionId: "version-a",
  status: "scheduled",
  createdAt: "2026-08-15T00:00:00.000Z",
  members: [
    { memberId: "member-1", email: "owner@example.test", displayName: "Owner", authority: "equal" },
    { memberId: "member-2", email: "friend@example.test", displayName: "Friend", authority: "equal" },
  ],
};

function storageWith(values: Record<string, unknown> = {}): PendingCommandStorage & { values: Record<string, unknown> } {
  return {
    values,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
  };
}

describe("Scheduled Challenge lifecycle seam", () => {
  it("derives Active at the exact Challenge Time Zone Start boundary", () => {
    expect(effectiveChallengeStatus(scheduled, "2026-08-16T06:59:59.999Z")).toBe("scheduled");
    expect(effectiveChallengeStatus(scheduled, "2026-08-16T07:00:00.000Z")).toBe("active");
    expect(challengeActionsForStatus("scheduled")).toEqual(["cancel"]);
    expect(challengeActionsForStatus("active")).toEqual(["solve"]);
    expect(challengeActionsForStatus("canceled")).toEqual([]);
  });

  it("uses authoritative instants independently of device clock and locale", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
      const first = effectiveChallengeStatus(scheduled, "2026-08-16T07:00:00.000Z");
      vi.setSystemTime(new Date("2035-12-31T23:59:59.999Z"));
      const second = effectiveChallengeStatus(scheduled, "2026-08-16T07:00:00.000Z");
      expect(first).toBe("active");
      expect(second).toBe(first);
      expect(dateInTimeZone("2026-08-16T07:00:00.000Z", "America/Los_Angeles")).toBe("2026-08-16");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cancellation recoverable and retries the same command key", async () => {
    const storage = storageWith();
    let attempts = 0;
    const adapter = createChallengeLifecycleCommandAdapter({
      storage,
      randomIdempotencyKey: () => "cancel-key",
      rpc: {
        async cancelChallenge(input) {
          expect(input.challengeId).toBe("challenge-1");
          expect(storage.values[PENDING_COMMAND_KEY]).toMatchObject({
            kind: CANCEL_CHALLENGE_COMMAND_KIND,
            intent: { challengeId: "challenge-1" },
          });
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return { ...scheduled, status: "canceled" as const, terminalActorId: "member-1", terminalAt: "2026-08-15T01:00:00.000Z" };
        },
      },
    });
    const identity = { memberId: "member-1", memberEmail: "owner@example.test" };

    await expect(adapter.cancelChallenge("challenge-1", identity)).resolves.toMatchObject({ status: "uncertain" });
    await expect(adapter.recover(identity)).resolves.toMatchObject({
      status: "applied",
      idempotencyKey: "cancel-key",
      challenge: { status: "canceled", terminalActorId: "member-1" },
    });
    expect(await adapter.readPending()).toBeNull();
  });

  it("returns a known Active-state boundary when cancellation is too late", async () => {
    const adapter = createChallengeLifecycleCommandAdapter({
      storage: storageWith(),
      rpc: { async cancelChallenge() { throw { code: "P0003", message: "The Challenge is already Active and cannot be canceled." }; } },
    });
    await expect(adapter.cancelChallenge("challenge-1", { memberId: "member-1", memberEmail: "owner@example.test" })).resolves.toMatchObject({
      status: "rejected",
      code: "validation",
      message: "The Challenge is already Active and cannot be canceled.",
    });
  });

  it("accepts lifecycle popup requests and focused snapshots", () => {
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "cancel_challenge", challengeId: "challenge-1" })).toBe(true);
    const snapshot = {
      contractVersion: PROTOCOL_VERSION,
      kind: "scheduled" as const,
      authoritativeServerTime: "2026-08-16T06:59:59.999Z",
      freshness: { revision: "r1", fetchedAt: "2026-08-16T06:59:59.999Z" },
      compatibility: { minimumClientVersion: "0.1.0" },
      backend: { status: "reachable" as const, schemaVersion: 6 },
      worker: { bootId: "boot-1", bootCount: 1, sessionRestoredFromStorage: true },
      challenge: scheduled,
      actions: ["cancel"] as const,
    };
    expect(isPopupResponse({ ok: true, snapshot })).toBe(true);
    expect(isPopupResponse({ ok: true, snapshot: {
      ...snapshot,
      kind: "terminal" as const,
      challenge: { ...scheduled, status: "canceled" as const, terminalActorId: "member-1", terminalAt: "2026-08-16T06:00:00.000Z" },
      actions: [] as const,
    } })).toBe(true);
  });
});
