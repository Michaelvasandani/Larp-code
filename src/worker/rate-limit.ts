export type SlidingWindowEntry = Readonly<{
  accountKey: string;
  destinationKey: string;
  attempts: number;
}>;

type Bucket = { startedAt: number; attempts: number };

/** In-memory boundary for a worker instance; the server remains authoritative. */
export function createSlidingWindowLimiter({
  maxAttempts,
  windowMs,
  now = () => Date.now(),
}: {
  maxAttempts: number;
  windowMs: number;
  now?: () => number;
}) {
  const buckets = new Map<string, Bucket>();

  function allow(accountKey: string, destinationKey: string): boolean {
    const key = `${accountKey}\u0000${destinationKey}`;
    const current = now();
    const existing = buckets.get(key);
    if (!existing || current - existing.startedAt >= windowMs) {
      buckets.set(key, { startedAt: current, attempts: 1 });
      return true;
    }
    if (existing.attempts >= maxAttempts) return false;
    existing.attempts += 1;
    return true;
  }

  function entries(): SlidingWindowEntry[] {
    const current = now();
    return [...buckets.entries()]
      .filter(([, bucket]) => current - bucket.startedAt < windowMs)
      .map(([key, bucket]) => {
        const [accountKey, destinationKey] = key.split("\u0000");
        return { accountKey: accountKey!, destinationKey: destinationKey!, attempts: bucket.attempts };
      });
  }

  return { allow, entries };
}
