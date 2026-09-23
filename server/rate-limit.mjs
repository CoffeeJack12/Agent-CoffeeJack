/**
 * Lightweight in-memory rate limits for sensitive remote endpoints.
 * Local direct-browser traffic is never limited.
 */

export function createRateLimiter({
  windowMs = 60_000,
  max = 30,
  now = Date.now,
} = {}) {
  const buckets = new Map();

  function keyFor(req, category) {
    const ip =
      req.socket?.remoteAddress ||
      req.headers?.["cf-connecting-ip"] ||
      "unknown";
    return `${category}:${ip}`;
  }

  function prune(ts) {
    for (const [key, bucket] of buckets) {
      if (ts - bucket.start > windowMs * 2) buckets.delete(key);
    }
  }

  return {
    /**
     * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
     */
    check(req, category, limit = max) {
      const ts = now();
      prune(ts);
      const key = keyFor(req, category);
      let bucket = buckets.get(key);
      if (!bucket || ts - bucket.start >= windowMs) {
        bucket = { start: ts, count: 0 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > limit)
        return {
          ok: false,
          retryAfterMs: Math.max(0, windowMs - (ts - bucket.start)),
        };
      return { ok: true };
    },
    reset() {
      buckets.clear();
    },
  };
}

export const REMOTE_RATE = {
  statusSession: { category: "remote_status", max: 40 },
  identityLink: { category: "identity_link", max: 20 },
  approval: { category: "approval", max: 60 },
  loginDenied: { category: "login_denied", max: 60 },
};
