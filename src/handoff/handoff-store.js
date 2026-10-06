import crypto from 'node:crypto';

export const HANDOFF_MIN_TTL_MS = 60_000;
export const HANDOFF_MAX_TTL_MS = 15 * 60_000;
export const HANDOFF_DEFAULT_TTL_MS = 5 * 60_000;
export const HANDOFF_MAX_VALUE_BYTES = 4096;
export const HANDOFF_MAX_FIELDS = 4;

const HANDOFF_FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HANDOFF_FIELD_TYPES = new Set(['text', 'password']);
const HANDOFF_FIELD_KEYS = new Set(['name', 'label', 'type']);

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

function validateFields(fields) {
  if (fields === undefined) return null;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > HANDOFF_MAX_FIELDS) {
    throw handoffError('invalid_fields', `Fields must contain between 1 and ${HANDOFF_MAX_FIELDS} entries`);
  }

  const names = new Set();
  return fields.map(field => {
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || Object.keys(field).some(key => !HANDOFF_FIELD_KEYS.has(key))) {
      throw handoffError('invalid_fields', 'Each field must contain only name, label, and type');
    }
    if (typeof field.name !== 'string' || !HANDOFF_FIELD_NAME_RE.test(field.name)
      || field.name === 'csrf' || names.has(field.name)) {
      throw handoffError('invalid_fields', 'Field names must be unique, safe identifiers');
    }
    if (typeof field.label !== 'string' || field.label.trim().length < 1 || field.label.length > 100) {
      throw handoffError('invalid_fields', 'Field labels must be between 1 and 100 characters');
    }
    if (!HANDOFF_FIELD_TYPES.has(field.type)) {
      throw handoffError('invalid_fields', 'Field type must be text or password');
    }
    names.add(field.name);
    return { name: field.name, label: field.label, type: field.type };
  });
}

function validatedSubmission(fields, value) {
  if (!fields) {
    if (typeof value !== 'string' || value.length === 0) throw handoffError('invalid_value', 'A value is required');
    if (Buffer.byteLength(value, 'utf8') > HANDOFF_MAX_VALUE_BYTES) {
      throw handoffError('value_too_large', 'Value exceeds the size limit');
    }
    return value;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw handoffError('invalid_value', 'All configured fields are required');
  }
  const expectedNames = fields.map(field => field.name);
  const submittedNames = Object.keys(value);
  if (submittedNames.length !== expectedNames.length
    || submittedNames.some(name => !expectedNames.includes(name))) {
    throw handoffError('invalid_value', 'Submitted fields must exactly match the configured schema');
  }

  let bytes = 0;
  const result = {};
  for (const name of expectedNames) {
    const submitted = value[name];
    if (typeof submitted !== 'string' || submitted.length === 0) {
      throw handoffError('invalid_value', 'All configured fields are required');
    }
    bytes += Buffer.byteLength(submitted, 'utf8');
    result[name] = submitted;
  }
  if (bytes > HANDOFF_MAX_VALUE_BYTES) {
    throw handoffError('value_too_large', 'Combined field values exceed the size limit');
  }
  return result;
}

export class HandoffStore {
  constructor({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
    this.now = now;
    this.randomBytes = randomBytes;
    this.sessions = new Map();
    this.waiters = new Map();
    this.viewWaiters = new Map();
  }

  create({ ttlMs = HANDOFF_DEFAULT_TTL_MS, label = 'Secure value', fields } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < HANDOFF_MIN_TTL_MS || ttlMs > HANDOFF_MAX_TTL_MS) {
      throw handoffError('invalid_ttl', 'TTL must be between 1 and 15 minutes');
    }
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) {
      throw handoffError('invalid_label', 'Label must be between 1 and 100 characters');
    }

    const validatedFields = validateFields(fields);
    const id = this.randomBytes(16).toString('hex');
    const manageToken = this.randomBytes(32).toString('base64url');
    const csrfToken = this.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.sessions.set(id, {
      id,
      mode: 'submit',
      label,
      fields: validatedFields,
      manageTokenHash: digest(manageToken),
      csrfTokenHash: digest(csrfToken),
      csrfTokenForRoute: csrfToken,
      state: 'waiting',
      value: null,
      createdAt,
      expiresAt: createdAt + ttlMs,
      attempts: new Map(),
      routeHost: null,
    });
    return { id, manageToken, createdAt, expiresAt: createdAt + ttlMs };
  }

  createReveal({ value, ttlMs = HANDOFF_DEFAULT_TTL_MS, label = 'Secure value' } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < HANDOFF_MIN_TTL_MS || ttlMs > HANDOFF_MAX_TTL_MS) {
      throw handoffError('invalid_ttl', 'TTL must be between 1 and 15 minutes');
    }
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) {
      throw handoffError('invalid_label', 'Label must be between 1 and 100 characters');
    }
    if (typeof value !== 'string' || value.length === 0) throw handoffError('invalid_value', 'A value is required');
    if (Buffer.byteLength(value, 'utf8') > HANDOFF_MAX_VALUE_BYTES) {
      throw handoffError('value_too_large', 'Value exceeds the size limit');
    }

    const id = this.randomBytes(16).toString('hex');
    const manageToken = this.randomBytes(32).toString('base64url');
    const csrfToken = this.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.sessions.set(id, {
      id,
      mode: 'reveal',
      label,
      manageTokenHash: digest(manageToken),
      csrfTokenHash: digest(csrfToken),
      csrfTokenForRoute: csrfToken,
      state: 'ready',
      value,
      createdAt,
      expiresAt: createdAt + ttlMs,
      attempts: new Map(),
      routeHost: null,
    });
    return { id, manageToken, createdAt, expiresAt: createdAt + ttlMs };
  }

  _live(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now() && !['consumed', 'viewed', 'revoked'].includes(session.state)) {
      session.value = null;
      session.csrfTokenForRoute = null;
      session.state = 'expired';
      this._rejectWaiters(id, handoffError('expired', 'Handoff expired'));
      this._rejectViewWaiters(id, handoffError('expired', 'Handoff expired'));
    }
    return session;
  }

  publicView(id) {
    const session = this._live(id);
    if (!session || !['waiting', 'ready'].includes(session.state)) return null;
    return {
      id: session.id,
      mode: session.mode,
      label: session.label,
      expiresAt: session.expiresAt,
      fields: session.fields?.map(field => ({ ...field })) ?? null,
    };
  }

  formCsrfToken(id, routeHost) {
    const session = this._live(id);
    if (!session || !['waiting', 'ready'].includes(session.state)) return null;
    if (routeHost) {
      if (session.routeHost && session.routeHost !== routeHost) return null;
      session.routeHost = routeHost;
    }
    return session.csrfTokenForRoute;
  }

  routeHostMatches(id, routeHost) {
    const session = this._live(id);
    return Boolean(session && routeHost && session.routeHost === routeHost);
  }

  recordAttempt(id, ip, { windowMs = 60_000, max = 8 } = {}) {
    const session = this._live(id);
    if (!session || !['waiting', 'ready'].includes(session.state)) return { allowed: false, reason: 'unavailable' };
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
    session.value = validatedSubmission(session.fields, value);
    session.state = 'submitted';
    session.submittedAt = this.now();
    const submittedAt = session.submittedAt;
    session.csrfTokenHash = digest(this.randomBytes(32));
    session.csrfTokenForRoute = null;
    session.attempts.clear();
    this._resolveWaiters(id);
    return { state: 'submitted', submittedAt };
  }

  reveal(id, csrfToken) {
    const session = this._live(id);
    if (!session || session.mode !== 'reveal' || session.state !== 'ready') {
      throw handoffError('unavailable', 'Handoff is unavailable');
    }
    if (!tokenMatches(session.csrfTokenHash, csrfToken)) throw handoffError('csrf', 'CSRF validation failed');
    const value = session.value;
    session.value = null;
    session.csrfTokenForRoute = null;
    session.state = 'viewed';
    session.viewedAt = this.now();
    session.csrfTokenHash = digest(this.randomBytes(32));
    session.attempts.clear();
    this._resolveViewWaiters(id);
    return value;
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
      viewedAt: session.viewedAt ?? null,
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

  awaitViewed(id, manageToken, { signal } = {}) {
    const session = this._authorized(id, manageToken);
    if (session.mode !== 'reveal') return Promise.reject(handoffError('invalid_request', 'Not a reveal handoff'));
    if (session.state === 'viewed') return Promise.resolve(this._viewedEvent(session));
    if (session.state !== 'ready') return Promise.reject(handoffError(session.state, `Handoff cannot be awaited (${session.state})`));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          this._removeViewWaiter(id, waiter);
          reject(handoffError('aborted', 'Handoff wait aborted'));
        };
        if (signal.aborted) return waiter.onAbort();
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const waiters = this.viewWaiters.get(id) || new Set();
      waiters.add(waiter);
      this.viewWaiters.set(id, waiters);
    });
  }

  revoke(id, manageToken) {
    const session = this._authorized(id, manageToken);
    if (session.state === 'revoked') return false;
    if (['consumed', 'viewed'].includes(session.state)) {
      throw handoffError(session.state, 'Completed handoffs cannot be revoked');
    }
    session.value = null;
    session.csrfTokenForRoute = null;
    session.state = 'revoked';
    session.revokedAt = this.now();
    this._rejectWaiters(id, handoffError('revoked', 'Handoff revoked'));
    this._rejectViewWaiters(id, handoffError('revoked', 'Handoff revoked'));
    return true;
  }

  cleanup() {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      this._live(id);
      if (['expired', 'consumed', 'viewed', 'revoked'].includes(session.state)) {
        session.value = null;
        session.csrfTokenForRoute = null;
        session.attempts.clear();
        this.sessions.delete(id);
        this._rejectWaiters(id, handoffError('unavailable', 'Handoff is unavailable'));
        this._rejectViewWaiters(id, handoffError('unavailable', 'Handoff is unavailable'));
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

  _viewedEvent(session) {
    return { id: session.id, state: 'viewed', viewedAt: session.viewedAt };
  }

  _removeViewWaiter(id, waiter) {
    const waiters = this.viewWaiters.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiters.size === 0) this.viewWaiters.delete(id);
  }

  _resolveViewWaiters(id) {
    const session = this.sessions.get(id);
    const waiters = [...(this.viewWaiters.get(id) || [])];
    for (const waiter of waiters) {
      this._removeViewWaiter(id, waiter);
      waiter.resolve(this._viewedEvent(session));
    }
  }

  _rejectViewWaiters(id, error) {
    const waiters = [...(this.viewWaiters.get(id) || [])];
    for (const waiter of waiters) {
      this._removeViewWaiter(id, waiter);
      waiter.reject(error);
    }
  }
}

export const handoffStore = new HandoffStore();
