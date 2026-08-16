import { dateInTimeZone } from "../shared/timezone";

export const CHALLENGE_SOLVE_TARGET = 150 as const;

export type ChallengeSchedule = Readonly<{
  timeZone: string;
  startDate: string;
  deadlineDate: string;
}>;

export type PaceStatus = "behind" | "on_pace_today" | "todays_pace_met";
export type PetCondition = "healthy" | "hungry" | "sad" | "deteriorated";
export type EvolutionStage = 1 | 2 | 3 | 4;

export type PaceResult = Readonly<{
  status: PaceStatus;
  previousTarget: number;
  currentTarget: number;
  gapToPreviousTarget: number;
  amountNeededToday: number;
  amountAhead: number;
  copy: string;
}>;

export type ActiveMemberProgress = Readonly<{
  memberId: string;
  email: string;
  displayName: string;
  creditedTotal: number;
  paceStatus: PaceStatus;
  pace: PaceResult;
}>;

export type ActiveProgress = Readonly<{
  problemSetVersionId: string;
  day: number;
  durationDays: number;
  expectedProgress: number;
  previousExpectedProgress: number;
  earlierExpectedProgress: number;
  pairProgress: number;
  petCondition: PetCondition;
  currentEvolutionStage: EvolutionStage;
  highestEvolutionStage: EvolutionStage;
  members: readonly ActiveMemberProgress[];
}>;

function dateDifferenceInDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Challenge dates must be ordered calendar dates.");
  }
  return Math.round((end - start) / 86_400_000);
}

export function challengeDurationDays(schedule: ChallengeSchedule): number {
  return dateDifferenceInDays(schedule.startDate, schedule.deadlineDate) + 1;
}

export function expectedProgressForCompletedDays(completedDays: number, durationDays: number): number {
  if (!Number.isInteger(completedDays) || !Number.isInteger(durationDays) || durationDays < 1) {
    throw new Error("Expected Progress requires a valid Challenge duration.");
  }
  const days = Math.max(0, Math.min(durationDays, completedDays));
  if (days === 0) return 0;
  return Math.ceil(CHALLENGE_SOLVE_TARGET * days / durationDays);
}

/** E(d) from SOLVE-016 using the Challenge Time Zone and authoritative time. */
export function calculateExpectedProgress(schedule: ChallengeSchedule, authoritativeNow: string): number {
  const durationDays = challengeDurationDays(schedule);
  const currentDate = dateInTimeZone(authoritativeNow, schedule.timeZone);
  if (currentDate < schedule.startDate) return 0;
  if (currentDate > schedule.deadlineDate) return CHALLENGE_SOLVE_TARGET;
  const completedDays = dateDifferenceInDays(schedule.startDate, currentDate) + 1;
  return expectedProgressForCompletedDays(completedDays, durationDays);
}

/** Returns the active calendar day, or 0 before start / D+1 after deadline. */
export function activeChallengeDay(schedule: ChallengeSchedule, authoritativeNow: string): number {
  const durationDays = challengeDurationDays(schedule);
  const currentDate = dateInTimeZone(authoritativeNow, schedule.timeZone);
  if (currentDate < schedule.startDate) return 0;
  if (currentDate > schedule.deadlineDate) return durationDays + 1;
  return dateDifferenceInDays(schedule.startDate, currentDate) + 1;
}

function paceCopy(status: PaceStatus, amount: number, ahead: number, priorGap: number): string {
  if (status === "behind") {
    return `Behind by ${priorGap} to the prior target; ${amount} more needed for today's target.`;
  }
  if (status === "on_pace_today") return `${amount} more needed for today's target.`;
  return ahead > 0 ? `Today's pace met; ${ahead} ahead of the target.` : "Today's pace met; 0 at the target.";
}

/** Derives a Member's recoverable cumulative relationship to today's targets. */
export function calculatePace(creditedTotal: number, previousTarget: number, currentTarget: number): PaceResult {
  if (![creditedTotal, previousTarget, currentTarget].every(Number.isFinite)) {
    throw new Error("Pace requires numeric totals and targets.");
  }
  const priorGap = Math.max(0, previousTarget - creditedTotal);
  const amountNeeded = Math.max(0, currentTarget - creditedTotal);
  const amountAhead = Math.max(0, creditedTotal - currentTarget);
  const status: PaceStatus = creditedTotal < previousTarget
    ? "behind"
    : creditedTotal < currentTarget
      ? "on_pace_today"
      : "todays_pace_met";
  return Object.freeze({
    status,
    previousTarget,
    currentTarget,
    gapToPreviousTarget: priorGap,
    amountNeededToday: amountNeeded,
    amountAhead,
    copy: paceCopy(status, amountNeeded, amountAhead, priorGap),
  });
}

export function calculatePairProgress(firstTotal: number, secondTotal: number): number {
  if (![firstTotal, secondTotal].every(Number.isFinite)) throw new Error("Pair Progress requires numeric totals.");
  return (firstTotal + secondTotal) / 2;
}

/** Applies PET-003 through PET-007 in order; upper Healthy threshold is inclusive. */
export function calculatePetCondition(
  pairProgress: number,
  previousExpectedProgress: number,
  currentExpectedProgress: number,
  earlierExpectedProgress = 0,
): PetCondition {
  if (pairProgress >= currentExpectedProgress) return "healthy";
  if (pairProgress >= previousExpectedProgress) return "hungry";
  if (pairProgress >= earlierExpectedProgress) return "sad";
  return "deteriorated";
}

/** Stages are one-indexed and are retained as a high-water mark. */
export function calculateEvolutionStage(pairProgress: number, highestEvolutionStage: EvolutionStage = 1): EvolutionStage {
  const current: EvolutionStage = pairProgress >= 150 ? 4 : pairProgress >= 100 ? 3 : pairProgress >= 50 ? 2 : 1;
  return Math.max(current, highestEvolutionStage) as EvolutionStage;
}

export function deriveActiveProgress(input: ChallengeSchedule & Readonly<{
  authoritativeNow: string;
  problemSetVersionId: string;
  members: readonly Readonly<{
    memberId: string;
    email: string;
    displayName: string;
    creditedTotal: number;
  }>[];
  highestEvolutionStage?: EvolutionStage;
}>): ActiveProgress {
  if (input.members.length !== 2) throw new Error("An Active Challenge requires exactly two Members.");
  const durationDays = challengeDurationDays(input);
  const day = activeChallengeDay(input, input.authoritativeNow);
  const currentDay = Math.max(1, Math.min(durationDays, day));
  const expectedProgress = calculateExpectedProgress(input, input.authoritativeNow);
  const previousExpectedProgress = day <= 0 ? 0 : expectedProgressForCompletedDays(Math.max(0, currentDay - 1), durationDays);
  const earlierExpectedProgress = day <= 1 ? 0 : expectedProgressForCompletedDays(Math.max(0, currentDay - 2), durationDays);
  const pairProgress = calculatePairProgress(input.members[0]!.creditedTotal, input.members[1]!.creditedTotal);
  const petCondition = calculatePetCondition(pairProgress, previousExpectedProgress, expectedProgress, earlierExpectedProgress);
  const currentEvolutionStage = calculateEvolutionStage(pairProgress);
  const highestEvolutionStage = calculateEvolutionStage(pairProgress, input.highestEvolutionStage ?? 1);
  return Object.freeze({
    problemSetVersionId: input.problemSetVersionId,
    day,
    durationDays,
    expectedProgress,
    previousExpectedProgress,
    earlierExpectedProgress,
    pairProgress,
    petCondition,
    currentEvolutionStage,
    highestEvolutionStage,
    members: Object.freeze(input.members.map((member) => {
      const pace = calculatePace(member.creditedTotal, previousExpectedProgress, expectedProgress);
      return Object.freeze({ ...member, paceStatus: pace.status, pace });
    })),
  });
}
