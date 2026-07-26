// Rate limiting for writes made by share-link holders. Attachment and state
// routes use distinct operation namespaces, so exhausting one surface cannot
// drain another surface's allowance.
//
// Two dimensions, because they cover different abuse:
//
//   token (primary) — the capability travels with a URL, so one link handed to
//     twenty people is twenty IPs against a single grant. Keying on the token
//     id rations the thing that was actually issued, and the thing that can
//     actually be revoked.
//   IP (secondary)  — a single source hammering one link is invisible to the
//     token bucket once the token bucket is generous enough to be usable, and
//     the app-wide limiter in security/rateLimit.js is too coarse to notice a
//     write burst inside normal browsing volume.
//
// Neither subsumes the other, so a request consumes both.
//
// State is per-process and in memory. That is the same reachability the login
// brute-force counters in security/auth.js already have, and it is honest about
// what it buys: a ceiling on sustained automated writes, not a distributed
// quota. A restart clears it.

const buckets = new Map();

// Prune is O(n) so it must not run per request. Above this many live token
// buckets one sweep drops everything already outside its window; a single
// instance with a handful of writable links never reaches it.
const PRUNE_THRESHOLD = 1000;

// ipMax sits above max on purpose: one person legitimately working through a
// shared checklist from one address may drive several links, and the IP bucket
// exists to catch bulk abuse, not to be the binding constraint in normal use.
export const DEFAULT_SHARE_WRITE_LIMIT = { windowMs: 60_000, max: 12, ipMax: 30 };

function pruneExpired(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function resolveWindowMs(limit) {
  return Number.isFinite(limit.windowMs) && limit.windowMs > 0
    ? limit.windowMs
    : DEFAULT_SHARE_WRITE_LIMIT.windowMs;
}

function hit(key, max, windowMs, now) {
  if (buckets.size > PRUNE_THRESHOLD) pruneExpired(now);
  const existing = buckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);
  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/**
 * Record one attempt against the token and IP quotas for one operation.
 *
 * Each mutation kind gets separate buckets on both dimensions. Sharing one
 * would let a burst of deletes exhaust the allowance for uploads or state
 * sets, and the operations have different costs.
 *
 * Both dimensions are always charged, even when the first one already failed,
 * so a caller cannot dodge the IP counter by exhausting the token counter.
 *
 * @returns {{allowed: boolean, dimension: string|null, remaining: number, retryAfterSeconds: number}}
 */
export function consumeShareWriteQuota(tokenId, operation, limit = {}, ip = null, now = Date.now()) {
  const windowMs = resolveWindowMs(limit);
  const max = Number.isFinite(limit.max) && limit.max >= 0
    ? limit.max
    : DEFAULT_SHARE_WRITE_LIMIT.max;
  const ipMax = Number.isFinite(limit.ipMax) && limit.ipMax >= 0
    ? limit.ipMax
    : DEFAULT_SHARE_WRITE_LIMIT.ipMax;

  const byToken = hit(`${operation}:token:${tokenId}`, max, windowMs, now);
  const byIp = ip ? hit(`${operation}:ip:${ip}`, ipMax, windowMs, now) : null;

  const failed = !byToken.allowed ? { dimension: 'token', ...byToken }
    : (byIp && !byIp.allowed ? { dimension: 'ip', ...byIp } : null);
  if (failed) return { ...failed, allowed: false };

  return {
    allowed: true,
    dimension: null,
    remaining: byIp ? Math.min(byToken.remaining, byIp.remaining) : byToken.remaining,
    retryAfterSeconds: byToken.retryAfterSeconds,
  };
}

// Test seam. Nothing in the running server calls this — buckets are meant to
// survive for the life of the process.
export function resetShareWriteQuota() {
  buckets.clear();
}
