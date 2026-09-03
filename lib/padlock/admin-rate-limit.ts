type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type PadlockAdminMutation = "binding" | "command" | "policy";

const WINDOW_MS = 60_000;
const BUCKET_CAP = 2_000;
const LIMITS: Record<PadlockAdminMutation, number> = {
  binding: 6,
  command: 10,
  policy: 8,
};

const buckets = new Map<string, RateLimitBucket>();
let lastSweepAt = 0;

function sweepExpiredBuckets(now: number) {
  if (now - lastSweepAt < WINDOW_MS && buckets.size < BUCKET_CAP) return;
  lastSweepAt = now;

  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }

  while (buckets.size >= BUCKET_CAP) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (!oldest) break;
    buckets.delete(oldest);
  }
}

export function consumePadlockAdminRateLimit(input: {
  actorUserId: number;
  mutation: PadlockAdminMutation;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const limit = LIMITS[input.mutation];
  const key = `${input.actorUserId}:${input.mutation}`;
  sweepExpiredBuckets(now);

  const current = buckets.get(key);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + WINDOW_MS };

  const allowed = bucket.count < limit;
  if (allowed) bucket.count += 1;
  buckets.set(key, bucket);

  const remaining = Math.max(0, limit - bucket.count);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket.resetAt - now) / 1_000)
  );

  return {
    allowed,
    retryAfterSeconds,
    headers: {
      "RateLimit-Limit": String(limit),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(retryAfterSeconds),
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset": String(Math.ceil(bucket.resetAt / 1_000)),
      ...(allowed ? {} : { "Retry-After": String(retryAfterSeconds) }),
    },
  };
}
