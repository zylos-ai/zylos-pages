function bucketKey(value) {
  return String(value || '').trim();
}

export class SharePasswordRateLimiter {
  constructor({ windowMs = 60_000, tokenMax = 8, ipMax = 24, now = Date.now } = {}) {
    for (const [name, value] of Object.entries({ windowMs, tokenMax, ipMax })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
    }
    this.windowMs = windowMs;
    this.tokenMax = tokenMax;
    this.ipMax = ipMax;
    this.now = now;
    this.tokenBuckets = new Map();
    this.ipBuckets = new Map();
  }

  #take(map, key, limit, current) {
    const existing = map.get(key);
    const bucket = !existing || current >= existing.resetAt
      ? { count: 0, resetAt: current + this.windowMs }
      : existing;
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    map.set(key, bucket);
    return true;
  }

  consume({ tokenId, clientIp }) {
    const token = bucketKey(tokenId);
    const ip = bucketKey(clientIp);
    if (!token || !ip) return { allowed: false, retryAfterMs: this.windowMs };
    const current = this.now();

    // Check both budgets before incrementing either. A rejected token-wide
    // attempt must not also consume the caller's IP allowance (and vice versa).
    const tokenBucket = this.tokenBuckets.get(token);
    const ipBucket = this.ipBuckets.get(ip);
    const tokenBlocked = tokenBucket && current < tokenBucket.resetAt && tokenBucket.count >= this.tokenMax;
    const ipBlocked = ipBucket && current < ipBucket.resetAt && ipBucket.count >= this.ipMax;
    if (tokenBlocked || ipBlocked) {
      const retryAt = Math.max(
        tokenBlocked ? tokenBucket.resetAt : current,
        ipBlocked ? ipBucket.resetAt : current,
      );
      return { allowed: false, retryAfterMs: Math.max(1, retryAt - current) };
    }
    this.#take(this.tokenBuckets, token, this.tokenMax, current);
    this.#take(this.ipBuckets, ip, this.ipMax, current);
    return { allowed: true, retryAfterMs: 0 };
  }

  prune() {
    const current = this.now();
    for (const map of [this.tokenBuckets, this.ipBuckets]) {
      for (const [key, bucket] of map) {
        if (current >= bucket.resetAt) map.delete(key);
      }
    }
  }
}
