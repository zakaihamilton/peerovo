export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxEntries = 10_000,
  ) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      !Number.isInteger(windowMs) ||
      windowMs < 1 ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1
    ) {
      throw new Error("Rate limit settings must be positive integers.");
    }
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= this.windowMs) {
      bucket = { windowStartedAt: now, count: 0 };
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= this.limit) {
      const remainingMs = Math.max(0, bucket.windowStartedAt + this.windowMs - now);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
      };
    }

    bucket.count += 1;
    this.trim();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private trim(): void {
    while (this.buckets.size > this.maxEntries) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
  }
}

export function getClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy && forwardedFor) {
    const headerValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstAddress = headerValue?.split(",", 1)[0]?.trim();
    if (firstAddress && firstAddress.length <= 128) return firstAddress;
  }
  return remoteAddress || "unknown";
}
