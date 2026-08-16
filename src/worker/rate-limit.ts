export type SlidingWindowStorage = Readonly<{
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
}>;

type Bucket = { windowStartedAt: number; attempts: number };

/** Worker fallback limiter backed by the same Member-owned storage as auth. */
export function createSlidingWindowLimiter({
  storage,
  prefix = "rate-limit.",
  maxAttempts,
  windowMs,
  now = () => Date.now(),
}: {
  storage: SlidingWindowStorage;
  prefix?: string;
  maxAttempts: number;
  windowMs: number;
  now?: () => number;
}) {
  async function allow(accountKey: string, destinationKey: string): Promise<boolean> {
    const key = `${prefix}${encodeURIComponent(accountKey)}:${encodeURIComponent(destinationKey)}`;
    const current = now();
    const stored = await storage.get(key);
    const existing = typeof stored === "object" && stored !== null
      ? stored as Partial<Bucket>
      : {};
    const windowStartedAt = typeof existing.windowStartedAt === "number" ? existing.windowStartedAt : current;
    const attempts = typeof existing.attempts === "number" ? existing.attempts : 0;
    if (current - windowStartedAt >= windowMs) {
      await storage.set(key, { windowStartedAt: current, attempts: 1 });
      return true;
    }
    if (attempts >= maxAttempts) return false;
    await storage.set(key, { windowStartedAt, attempts: attempts + 1 });
    return true;
  }

  return { allow };
}
