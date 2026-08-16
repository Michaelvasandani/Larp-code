export const COMPATIBILITY_BACKFILL_VERSION = "ticket-37-contract-v1" as const;

export type BackfillState = Readonly<{
  migrationVersion: typeof COMPATIBILITY_BACKFILL_VERSION;
  cursor: string | null;
  processedRows: number;
  completed: boolean;
}>;

/** Pure model of the version-marked, resumable SQL backfill cursor. */
export function advanceBackfill(
  state: BackfillState,
  orderedIds: readonly string[],
  batchSize: number,
): BackfillState {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("Backfill batch size must be between 1 and 1000.");
  }
  if (state.completed) return state;
  const candidates = [...new Set(orderedIds)]
    .filter((id) => state.cursor === null || id > state.cursor)
    .sort();
  const batch = candidates.slice(0, batchSize);
  if (batch.length === 0) return { ...state, completed: true };
  return {
    ...state,
    cursor: batch[batch.length - 1]!,
    processedRows: state.processedRows + batch.length,
    completed: batch.length < batchSize,
  };
}
