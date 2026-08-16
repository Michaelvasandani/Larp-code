import type { AppSnapshot } from "../shared/protocol";
import { isGrovekinPlaybackClip, type GrovekinPlaybackClip } from "./grovekin-clips";

export type GrovekinTransition = "none" | GrovekinPlaybackClip;

function sameChallenge(previous: AppSnapshot, current: AppSnapshot): boolean {
  return previous.kind !== "signed_out"
    && previous.kind !== "setup_required"
    && previous.kind !== "account"
    && previous.kind !== "invitation"
    && previous.kind !== "update_required"
    && current.kind !== "signed_out"
    && current.kind !== "setup_required"
    && current.kind !== "account"
    && current.kind !== "invitation"
    && current.kind !== "update_required"
    && Boolean(previous.challenge?.id)
    && previous.challenge?.id === current.challenge?.id;
}

/**
 * Map one committed Snapshot to a single playback clip. This deliberately
 * compares only authoritative freshness and payload transitions; local form
 * state, pending commands, and optimistic assumptions never trigger motion.
 */
export function deriveGrovekinTransition(
  previous: AppSnapshot | undefined,
  current: AppSnapshot,
): GrovekinTransition {
  if (!previous || previous.freshness.revision === current.freshness.revision || !sameChallenge(previous, current)) return "none";

  if (current.kind === "terminal" && current.challenge?.status === "completed" && previous.kind === "active") {
    return "stage-4-farewell";
  }
  if (previous.kind !== "active" || current.kind !== "active") return "none";

  const previousProgress = previous.progress;
  const currentProgress = current.progress;
  if (currentProgress.currentEvolutionStage === 4
    && currentProgress.pairProgress >= 150
    && previousProgress.pairProgress < 150) {
    return "stage-4-farewell";
  }
  if (currentProgress.currentEvolutionStage > previousProgress.currentEvolutionStage
    && currentProgress.currentEvolutionStage === previousProgress.currentEvolutionStage + 1) {
    return "evolution-transition";
  }
  const previousSolveIds = new Set((previous.challenge.solveHistory ?? []).map((solve) => solve.id));
  const hasNewSolve = (current.challenge.solveHistory ?? []).some((solve) => !previousSolveIds.has(solve.id));
  if (hasNewSolve) {
    return "solve-reaction";
  }
  if (currentProgress.petCondition !== previousProgress.petCondition
    && currentProgress.petCondition !== "healthy") {
    const clipId = `${currentProgress.petCondition}-accent`;
    if (isGrovekinPlaybackClip(clipId)) return clipId;
  }
  return "none";
}
