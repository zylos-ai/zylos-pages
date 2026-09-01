import crypto from 'node:crypto';

export const HANDOFF_MIN_TTL_MS = 60_000;
export const HANDOFF_MAX_TTL_MS = 15 * 60_000;
export const HANDOFF_DEFAULT_TTL_MS = 5 * 60_000;
export const HANDOFF_MAX_VALUE_BYTES = 4096;

function handoffError(code, message) {
  return Object.assign(new Error(message), { code });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function tokenMatches(expected, candidate) {
  if (typeof candidate !== 'string') return false;
  const actual = digest(candidate);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export class HandoffStore {
  constructor({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
    this.now = now;
    this.randomBytes = randomBytes;
    this.sessions = new Map();
    this.waiters = new Map();
  }

  create({ ttlMs = HANDOFF_DEFAULT_TTL_MS, label = 'Secure value' } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < HANDOFF_MIN_TTL_MS || ttlMs > HANDOFF_MAX_TTL_MS) {
      throw handoffError('invalid_ttl', 'TTL must be between 1 and 15 minutes');
    }
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) {
      throw handoffError('invalid_label', 'Label must be between 1 and 100 characters');
    }

    const id = this.randomBytes(16).toString('hex');
    const manageToken = this.randomBytes(32).toString('base64url');
    const csrfToken = this.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.sessions.set(id, {
      id,
      label,
      manageTokenHash: digest(manageToken),
      csrfTokenHash: digest(csrfToken),
      csrfTokenForRoute: csrfToken,
      state: 'waiting',
      value: null,
      createdAt,
      expiresAt: createdAt + ttlMs,
      attempts: new Map(),
    });
    return { id, manageToken, createdAt, expiresAt: createdAt + ttlMs };
  }

  _live(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now() && !['consumed', 'revoked'].includes(session.state)) {
      session.value = null;
      session.csrfTokenForRoute = null;
      session.state = 'expired';
      this._rejectWaiters(id, handoffError('expired', 'Handoff expired'));
    }
    return session;
  }

  publicView(id) {
    const session = this._live(id);
    if (!session || session.state !== 'waiting') return null;
    return { id: session.id, label: session.label, expiresAt: session.expiresAt };
  }

  formCsrfToken(id) {
    const session = this._live(id);
    return session?.state === 'waiting' ? session.csrfTokenForRoute : null;
  }

  recordAttempt(id, ip, { windowMs = 60_000, max = 8 } = {}) {
    const session = this._live(id);
    if (!session || session.state !== 'waiting') return { allowed: false, reason: 'unavailable' };
    const key = typeof ip === 'string' && ip ? ip : 'unknown';
    const now = this.now();
    const previous = session.attempts.get(key);
    const bucket = !previous || now - previous.startedAt >= windowMs
      ? { startedAt: now, count: 0 }
      : previous;
    bucket.count += 1;
    session.attempts.set(key, bucket);
    if (bucket.count > max) {
      return { allowed: false, reason: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000)) };
    }
    return { allowed: true };
  }

  submit(id, csrfToken, value) {
    const session = this._live(id);
    if (!session || session.state !== 'waiting') throw handoffError('unavailable', 'Handoff is unavailable');
    if (!tokenMatches(session.csrfTokenHash, csrfToken)) throw handoffError('csrf', 'CSRF validation failed');
    if (typeof value !== 'string' || value.length === 0) throw handoffError('invalid_value', 'A value is required');
    if (Buffer.byteLength(value, 'utf8') > HANDOFF_MAX_VALUE_BYTES) {
      throw handoffError('value_too_large', 'Value exceeds the size limit');
    }
    session.value = value;
    session.state = 'submitted';
    session.submittedAt = this.now();
    const submittedAt = session.submittedAt;
    session.csrfTokenHash = digest(this.randomBytes(32));
    session.csrfTokenForRoute = null;
    session.attempts.clear();
    this._resolveWaiters(id);
    return { state: 'submitted', submittedAt };
  }

  status(id, manageToken) {
    const session = this._authorized(id, manageToken);
    return {
      id,
      state: session.state,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      submittedAt: session.submittedAt ?? null,
      consumedAt: session.consumedAt ?? null,
      revokedAt: session.revokedAt ?? null,
    };
  }

  consume(id, manageToken) {
    const session = this._authorized(id, manageToken);
    if (session.state !== 'submitted') throw handoffError(session.state, `Handoff cannot be consumed (${session.state})`);
    const value = session.value;
    session.value = null;
    session.csrfTokenForRoute = null;
    session.state = 'consumed';
    session.consumedAt = this.now();
    this._rejectWaiters(id, handoffError('consumed', 'Handoff already consumed'));
    return value;
  }

  awaitAndConsume(id, manageToken, { signal } = {}) {
    const session = this._authorized(id, manageToken);
    if (session.state === 'submitted') return Promise.resolve(this.consume(id, manageToken));
    if (session.state !== 'waiting') return Promise.reject(handoffError(session.state, `Handoff cannot be awaited (${session.state})`));
    return new Promise((resolve, reject) => {
      const waiter = { manageToken, resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          this._removeWaiter(id, waiter);
          reject(handoffError('aborted', 'Handoff wait aborted'));
        };
        if (signal.aborted) return waiter.onAbort();
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const waiters = this.waiters.get(id) || new Set();
      waiters.add(waiter);
      this.waiters.set(id, waiters);
    });
  }

  revoke(id, manageToken) {
    const session = this._authorized(id, manageToken);
    if (session.state === 'revoked') return false;
    if (session.state === 'consumed') throw handoffError('consumed', 'Consumed handoffs cannot be revoked');
    session.value = null;
    session.csrfTokenForRoute = null;
    session.state = 'revoked';
    session.revokedAt = this.now();
    this._rejectWaiters(id, handoffError('revoked', 'Handoff revoked'));
    return true;
  }

  cleanup() {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      this._live(id);
      if (session.state === 'expired' || session.state === 'consumed' || session.state === 'revoked') {
        session.value = null;
        session.csrfTokenForRoute = null;
        session.attempts.clear();
        this.sessions.delete(id);
        this._rejectWaiters(id, handoffError('unavailable', 'Handoff is unavailable'));
        removed += 1;
      }
    }
    return removed;
  }

  _authorized(id, manageToken) {
    const session = this._live(id);
    if (!session || !tokenMatches(session.manageTokenHash, manageToken)) {
      throw handoffError('not_found', 'Handoff not found');
    }
    return session;
  }

  _removeWaiter(id, waiter) {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiters.size === 0) this.waiters.delete(id);
  }

  _resolveWaiters(id) {
    const waiters = [...(this.waiters.get(id) || [])];
    for (const waiter of waiters) {
      this._removeWaiter(id, waiter);
      try { waiter.resolve(this.consume(id, waiter.manageToken)); }
      catch (err) { waiter.reject(err); }
    }
  }

  _rejectWaiters(id, error) {
    const waiters = [...(this.waiters.get(id) || [])];
    for (const waiter of waiters) {
      this._removeWaiter(id, waiter);
      waiter.reject(error);
    }
  }
}

export const handoffStore = new HandoffStore();
