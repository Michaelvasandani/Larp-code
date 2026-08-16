/** Popup-lifetime Realtime invalidation seam. Event payloads never become UI state. */
export function createDebouncedSnapshotInvalidation({
  refetch,
  onInvalidated,
  onUnavailable,
  delayMs = 250,
}: {
  refetch: () => Promise<unknown>;
  onInvalidated: () => void;
  onUnavailable?: () => void;
  delayMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function invalidate(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refetch()
        .then(() => onInvalidated())
        .catch(() => onUnavailable?.());
    }, delayMs);
  }

  function dispose(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { invalidate, dispose };
}
