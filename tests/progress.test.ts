import { describe, expect, it } from "vitest";

import {
  calculateExpectedProgress,
  calculateEvolutionStage,
  calculatePace,
  calculatePairProgress,
  calculatePetCondition,
  deriveActiveProgress,
} from "../src/worker/progress";

const schedule = {
  timeZone: "UTC",
  startDate: "2026-08-01",
  deadlineDate: "2026-08-30",
};

describe("authoritative progress and Pet seam", () => {
  it("uses zero before activation, inclusive active days, and 150 after the deadline", () => {
    expect(calculateExpectedProgress(schedule, "2026-07-31T23:59:59.999Z")).toBe(0);
    expect(calculateExpectedProgress(schedule, "2026-08-01T00:00:00.000Z")).toBe(5);
    expect(calculateExpectedProgress(schedule, "2026-08-30T23:59:59.999Z")).toBe(150);
    expect(calculateExpectedProgress(schedule, "2026-08-31T00:00:00.000Z")).toBe(150);
  });

  it("rounds each cumulative target upward independently", () => {
    const short = { ...schedule, deadlineDate: "2026-08-02" };
    expect(calculateExpectedProgress(short, "2026-08-01T12:00:00.000Z")).toBe(75);
    expect(calculateExpectedProgress(short, "2026-08-02T12:00:00.000Z")).toBe(150);
  });

  it("keeps pace status and copy recoverable through early work and catch-up", () => {
    expect(calculatePace(0, 5, 10)).toMatchObject({
      status: "behind",
      gapToPreviousTarget: 5,
      amountNeededToday: 10,
    });
    expect(calculatePace(7, 5, 10)).toMatchObject({
      status: "on_pace_today",
      amountNeededToday: 3,
    });
    expect(calculatePace(10, 5, 10)).toMatchObject({
      status: "todays_pace_met",
      amountAhead: 0,
    });
    expect(calculatePace(12, 5, 10)).toMatchObject({
      status: "todays_pace_met",
      amountAhead: 2,
    });
  });

  it("uses the exact fractional pair average and all Pet bands", () => {
    expect(calculatePairProgress(7, 8)).toBe(7.5);
    expect(calculatePetCondition(0, 0, 10, 0)).toBe("hungry");
    expect(calculatePetCondition(10, 5, 10, 0)).toBe("healthy");
    expect(calculatePetCondition(3, 5, 10, 0)).toBe("sad");
    expect(calculatePetCondition(-1, 5, 10, 0)).toBe("deteriorated");
  });

  it("attains stages inclusively and never regresses the high-water mark", () => {
    expect(calculateEvolutionStage(0)).toBe(1);
    expect(calculateEvolutionStage(50)).toBe(2);
    expect(calculateEvolutionStage(100)).toBe(3);
    expect(calculateEvolutionStage(150)).toBe(4);
    expect(calculateEvolutionStage(20, 3)).toBe(3);
  });

  it("derives both Members, pair state, and pinned catalog identity together", () => {
    const result = deriveActiveProgress({
      ...schedule,
      authoritativeNow: "2026-08-03T12:00:00.000Z",
      problemSetVersionId: "version-a",
      members: [
        { memberId: "a", email: "a@example.test", displayName: "A", creditedTotal: 8 },
        { memberId: "b", email: "b@example.test", displayName: "B", creditedTotal: 2 },
      ],
    });
    expect(result).toMatchObject({
      problemSetVersionId: "version-a",
      expectedProgress: 15,
      previousExpectedProgress: 10,
      pairProgress: 5,
      petCondition: "sad",
      currentEvolutionStage: 1,
      highestEvolutionStage: 1,
    });
    expect(result.members[0]).toMatchObject({ memberId: "a", paceStatus: "behind" });
    expect(result.members[1]).toMatchObject({ memberId: "b", paceStatus: "behind" });
  });
});
