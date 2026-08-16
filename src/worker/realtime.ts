/** Popup-lifetime Realtime invalidation seam. Event payloads never become UI state. */
export function createDebouncedSnapshotInvalidation({
  refetch,
  onInvalidated,
  delayMs = 250,
}: {
  refetch: () => Promise<unknown>;
  onInvalidated: () => void;
  delayMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function invalidate(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refetch().then(() => onInvalidated()).catch(() => undefined);
    }, delayMs);
  }

  function dispose(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { invalidate, dispose };
}
