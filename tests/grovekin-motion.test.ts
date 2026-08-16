import { describe, expect, it } from "vitest";

import { deriveGrovekinTransition } from "../src/popup/grovekin-motion";
import { PROTOCOL_VERSION, type AppSnapshot } from "../src/shared/protocol";

const metadata = {
  contractVersion: PROTOCOL_VERSION,
  authoritativeServerTime: "2026-08-16T00:00:00.000Z",
  compatibility: { minimumClientVersion: "0.1.0" },
  backend: { status: "reachable" as const, schemaVersion: 1 },
  worker: { bootId: "boot-1", bootCount: 1, sessionRestoredFromStorage: true },
};

function activeSnapshot(overrides: Record<string, unknown> = {}): AppSnapshot {
  return {
    ...metadata,
    kind: "active",
    freshness: { revision: "revision-1", fetchedAt: metadata.authoritativeServerTime },
    challenge: {
      id: "challenge-1",
      invitationId: "invitation-1",
      timeZone: "UTC",
      startDate: "2026-08-16",
      deadlineDate: "2026-09-14",
      problemSetVersionId: "pinned",
      status: "active",
      createdAt: metadata.authoritativeServerTime,
      members: [],
    },
    progress: {
      problemSetVersionId: "pinned",
      day: 1,
      durationDays: 30,
      expectedProgress: 5,
      previousExpectedProgress: 4,
      earlierExpectedProgress: 3,
      pairProgress: 5,
      petCondition: "healthy",
      currentEvolutionStage: 1,
      highestEvolutionStage: 1,
      members: [],
    },
    ...overrides,
  } as AppSnapshot;
}

describe("authoritative Grovekin transitions", () => {
  it("does not animate on initial load or a refresh with the same revision", () => {
    const initial = activeSnapshot();
    expect(deriveGrovekinTransition(undefined, initial)).toBe("none");
    expect(deriveGrovekinTransition(initial, { ...initial })).toBe("none");
  });

  it("plays solve reaction only after authoritative progress changes", () => {
    const previous = activeSnapshot();
    const previousActive = previous as Extract<AppSnapshot, { kind: "active" }>;
    const current = activeSnapshot({
      freshness: { revision: "revision-2", fetchedAt: metadata.authoritativeServerTime },
      progress: { ...previousActive.progress, pairProgress: 6 },
      challenge: {
        ...previousActive.challenge,
        solveHistory: [{ id: "solve-1", memberId: "member-1", challengeId: "challenge-1", problemId: "problem-1", claimedAt: metadata.authoritativeServerTime, creditStatus: "credited", originalCreditStatus: "credited", corrections: [] }],
      },
    });
    expect(deriveGrovekinTransition(previous, current)).toBe("solve-reaction");
  });

  it("plays one adjacent evolution transition and terminal farewell from authoritative snapshots", () => {
    const previous = activeSnapshot();
    const previousActive = previous as Extract<AppSnapshot, { kind: "active" }>;
    const evolved = activeSnapshot({
      freshness: { revision: "revision-2", fetchedAt: metadata.authoritativeServerTime },
      progress: { ...previousActive.progress, currentEvolutionStage: 2, highestEvolutionStage: 2 },
    });
    expect(deriveGrovekinTransition(previous, evolved)).toBe("evolution-transition");

    const completed = {
      ...evolved,
      kind: "terminal" as const,
      challenge: { ...(evolved as Extract<AppSnapshot, { kind: "active" }>).challenge, status: "completed" as const },
      freshness: { revision: "revision-3", fetchedAt: metadata.authoritativeServerTime },
    } as AppSnapshot;
    expect(deriveGrovekinTransition(evolved, completed)).toBe("stage-4-farewell");
  });

  it("can begin the Stage-4 farewell on an authoritative final Active Snapshot", () => {
    const previous = activeSnapshot();
    const previousActive = previous as Extract<AppSnapshot, { kind: "active" }>;
    const finalActive = activeSnapshot({
      freshness: { revision: "revision-2", fetchedAt: metadata.authoritativeServerTime },
      progress: {
        ...previousActive.progress,
        pairProgress: 150,
        currentEvolutionStage: 4,
        highestEvolutionStage: 4,
      },
    });
    expect(deriveGrovekinTransition(previous, finalActive)).toBe("stage-4-farewell");
  });

  it("uses a condition accent only when the authoritative condition changes", () => {
    const previous = activeSnapshot();
    const previousActive = previous as Extract<AppSnapshot, { kind: "active" }>;
    const current = activeSnapshot({
      freshness: { revision: "revision-2", fetchedAt: metadata.authoritativeServerTime },
      progress: { ...previousActive.progress, petCondition: "sad" },
    });
    expect(deriveGrovekinTransition(previous, current)).toBe("sad-accent");
  });

  it("does not replay Solve for a correction that changes Pair Progress", () => {
    const previous = activeSnapshot({
      challenge: {
        ...((activeSnapshot() as Extract<AppSnapshot, { kind: "active" }>).challenge),
        solveHistory: [{ id: "solve-1", memberId: "member-1", challengeId: "challenge-1", problemId: "problem-1", claimedAt: metadata.authoritativeServerTime, creditStatus: "credited", originalCreditStatus: "credited", corrections: [] }],
      },
    });
    const previousActive = previous as Extract<AppSnapshot, { kind: "active" }>;
    const corrected = activeSnapshot({
      freshness: { revision: "revision-2", fetchedAt: metadata.authoritativeServerTime },
      progress: { ...previousActive.progress, pairProgress: 6 },
      challenge: { ...previousActive.challenge, solveHistory: [{ ...previousActive.challenge.solveHistory![0], corrections: [{ id: "correction-1" }] }] },
    });
    expect(deriveGrovekinTransition(previous, corrected)).not.toBe("solve-reaction");
  });
});
