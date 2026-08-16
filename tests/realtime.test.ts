import { describe, expect, it, vi } from "vitest";

import { createDebouncedSnapshotInvalidation } from "../src/worker/realtime";

describe("Realtime invalidation seam", () => {
  it("debounces events, refetches the full Snapshot, and emits only after refetch", async () => {
    vi.useFakeTimers();
    try {
      const refetch = vi.fn(async () => ({ kind: "active", progress: { pairProgress: 42 } }));
      const onInvalidated = vi.fn();
      const invalidation = createDebouncedSnapshotInvalidation({ refetch, onInvalidated, delayMs: 250 });
      invalidation.invalidate();
      invalidation.invalidate();
      vi.advanceTimersByTime(249);
      expect(refetch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(refetch).toHaveBeenCalledOnce();
      expect(onInvalidated).toHaveBeenCalledOnce();
      expect(onInvalidated).not.toHaveBeenCalledWith(expect.objectContaining({ progress: expect.anything() }));
      invalidation.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
