import crypto from 'node:crypto';

export const HANDOFF_MIN_TTL_MS = 60_000;
export const HANDOFF_MAX_TTL_MS = 15 * 60_000;
export const HANDOFF_DEFAULT_TTL_MS = 5 * 60_000;
export const HANDOFF_MAX_VALUE_BYTES = 4096;
export const HANDOFF_MAX_FIELDS = 4;
// File limits apply to the total size of all files in one handoff.
export const HANDOFF_DEFAULT_FILE_BYTES = 5 * 1024 * 1024;
export const HANDOFF_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const HANDOFF_DEFAULT_FILES = 5;
export const HANDOFF_MAX_FILES = 10;

const HANDOFF_FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HANDOFF_FIELD_TYPES = new Set(['text', 'password']);
const HANDOFF_FIELD_KEYS = new Set(['name', 'label', 'type']);
// Common file systems (ext4, APFS, NTFS via UTF-8 tools) cap a name at 255
// bytes, so every name we emit fits in 255 UTF-8 bytes, suffixes included.
export const HANDOFF_MAX_FILENAME_BYTES = 255;
// An "extension" longer than this is treated as part of the stem.
const HANDOFF_MAX_EXTENSION_BYTES = 32;
const HANDOFF_ACCEPT_KINDS = new Set(['text', 'file']);
const HANDOFF_CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

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

function validateAccept(accept, fields, maxBytes, maxFiles) {
  if (!HANDOFF_ACCEPT_KINDS.has(accept)) {
    throw handoffError('invalid_accept', 'Accept must be text or file');
  }
  if (accept === 'text') {
    if (maxBytes !== undefined) {
      throw handoffError('invalid_max_bytes', 'maxBytes applies only to file handoffs');
    }
    if (maxFiles !== undefined) {
      throw handoffError('invalid_max_files', 'maxFiles applies only to file handoffs');
    }
    return null;
  }
  if (fields !== undefined) {
    throw handoffError('invalid_fields', 'File handoffs do not accept named fields');
  }
  const limit = maxBytes === undefined ? HANDOFF_DEFAULT_FILE_BYTES : maxBytes;
  if (!Number.isInteger(limit) || limit < 1 || limit > HANDOFF_MAX_FILE_BYTES) {
    throw handoffError('invalid_max_bytes', `maxBytes must be between 1 and ${HANDOFF_MAX_FILE_BYTES}`);
  }
  const count = maxFiles === undefined ? HANDOFF_DEFAULT_FILES : maxFiles;
  if (!Number.isInteger(count) || count < 1 || count > HANDOFF_MAX_FILES) {
    throw handoffError('invalid_max_files', `maxFiles must be between 1 and ${HANDOFF_MAX_FILES}`);
  }
  return { maxBytes: limit, maxFiles: count };
}

function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  const ext = name.slice(dot);
  return Buffer.byteLength(ext) > HANDOFF_MAX_EXTENSION_BYTES ? [name, ''] : [name.slice(0, dot), ext];
}

// Build `stem + suffix + ext` within the byte budget, shortening only the stem
// and only by whole code points, so the extension and any " (n)" suffix
// survive and a surrogate pair is never split.
export function fitFilename(name, suffix = '') {
  const [stem, ext] = splitExtension(name);
  const reserved = Buffer.byteLength(suffix) + Buffer.byteLength(ext);
  const kept = [];
  let bytes = 0;
  for (const char of stem) {
    const size = Buffer.byteLength(char);
    if (bytes + size + reserved > HANDOFF_MAX_FILENAME_BYTES) break;
    kept.push(char);
    bytes += size;
  }
  return `${kept.join('').trimEnd()}${suffix}${ext}`;
}

// The filename is only a hint for the consumer. Reduce it to a plain base name
// without control characters so it can never carry a path or terminal escape.
function safeFilename(filename) {
  const name = String(filename ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
  const base = fitFilename(name);
  return base && base !== '.' && base !== '..' ? base : 'upload';
}

function safeContentType(contentType) {
  const normalized = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
  return HANDOFF_CONTENT_TYPE_RE.test(normalized) ? normalized : 'application/octet-stream';
}

// Comparison key for "same name on disk". Default APFS and NTFS are
// case-insensitive and APFS is also Unicode-normalization-insensitive, so
// "é.txt" and "e\u0301.txt" or "Key.json" and "KEY.JSON" are one path there.
// NFKC plus lower-upper-lower case mapping merges at least those. Lowering
// first matters: "ẞ" upper-cases to itself, so only lower ("ß") then upper
// ("SS") reaches "ss" like "ß" does. For every code point this key agrees with
// Unicode full case folding (checked against Python's str.casefold in the
// tests). Merging a little more than a given file system does only costs an
// unneeded " (n)" suffix, never an overwrite.
export function filenameKey(name) {
  return name.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase().normalize('NFKC');
}

// Two files with the same name would overwrite each other when the consumer
// writes them out or when they share a ZIP, so later duplicates get " (2)",
// " (3)" ... before the extension, still within the 255-byte name budget.
function uniqueFilenames(files) {
  const seen = new Set();
  return files.map(file => {
    let name = file.filename;
    for (let n = 2; seen.has(filenameKey(name)); n++) name = fitFilename(file.filename, ` (${n})`);
    seen.add(filenameKey(name));
    return { ...file, filename: name };
  });
}

function validatedFileSubmission(session, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw handoffError('invalid_value', 'At least one non-empty file is required');
  }
  if (value.length > session.maxFiles) throw handoffError('invalid_value', 'Too many files');
  let total = 0;
  for (const file of value) {
    if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.data) || file.data.length === 0) {
      throw handoffError('invalid_value', 'Every file must be non-empty');
    }
    total += file.data.length;
  }
  if (total > session.maxBytes) throw handoffError('value_too_large', 'Files exceed the size limit');
  const files = uniqueFilenames(value.map(file => ({
    filename: safeFilename(file.filename),
    contentType: safeContentType(file.contentType),
    data: file.data,
  })));
  return {
    files: files.map(file => ({
      filename: file.filename,
      contentType: file.contentType,
      size: file.data.length,
      data: file.data.toString('base64'),
    })),
  };
}

// Strict padded base64. A grouped pattern like (?:[A-Za-z0-9+/]{4})* overflows
// the regex stack on multi-MiB input, so check the alphabet with a flat
// character class and the padding with the length.
const BASE64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const isStrictBase64 = data => data.length % 4 === 0 && BASE64_CHARS_RE.test(data);
const HANDOFF_MAX_FILE_BASE64_CHARS = Math.ceil(HANDOFF_MAX_FILE_BYTES / 3) * 4;

// Reveal files arrive from the trusted local socket as strict base64. Decode
// each once into a Buffer, apply the same name/type normalization as uploads,
// and keep only what the download response needs.
function validatedRevealFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > HANDOFF_MAX_FILES) {
    throw handoffError('invalid_value', `Send 1 to ${HANDOFF_MAX_FILES} files`);
  }
  let encoded = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || typeof file.data !== 'string' || file.data.length === 0 || !isStrictBase64(file.data)) {
      throw handoffError('invalid_value', 'Every file needs non-empty base64 data');
    }
    encoded += file.data.length;
  }
  // Cheap bound before decoding anything.
  if (encoded > HANDOFF_MAX_FILE_BASE64_CHARS + files.length * 4) {
    throw handoffError('value_too_large', 'Files exceed the size limit');
  }
  const decoded = files.map(file => ({
    filename: safeFilename(file.filename),
    contentType: safeContentType(file.contentType),
    data: Buffer.from(file.data, 'base64'),
  }));
  const total = decoded.reduce((sum, file) => sum + file.data.length, 0);
  if (total > HANDOFF_MAX_FILE_BYTES) throw handoffError('value_too_large', 'Files exceed the size limit');
  return uniqueFilenames(decoded);
}

function validatedSubmission(session, value) {
  if (session.accept === 'file') return validatedFileSubmission(session, value);
  const { fields } = session;
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

// Reveal files are held as Buffers; zero them when a session ends without a
// download (expiry, revoke) instead of only dropping the reference.
function dropValue(session) {
  if (Array.isArray(session.value)) {
    for (const file of session.value) if (Buffer.isBuffer(file?.data)) file.data.fill(0);
  }
  session.value = null;
}

export class HandoffStore {
  constructor({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
    this.now = now;
    this.randomBytes = randomBytes;
    this.sessions = new Map();
    this.waiters = new Map();
    this.viewWaiters = new Map();
  }

  create({ ttlMs = HANDOFF_DEFAULT_TTL_MS, label = 'Secure value', fields, accept = 'text', maxBytes, maxFiles } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < HANDOFF_MIN_TTL_MS || ttlMs > HANDOFF_MAX_TTL_MS) {
      throw handoffError('invalid_ttl', 'TTL must be between 1 and 15 minutes');
    }
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) {
      throw handoffError('invalid_label', 'Label must be between 1 and 100 characters');
    }

    const fileLimits = validateAccept(accept, fields, maxBytes, maxFiles);
    const validatedFields = validateFields(fields);
    const id = this.randomBytes(16).toString('hex');
    const manageToken = this.randomBytes(32).toString('base64url');
    const csrfToken = this.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.sessions.set(id, {
      id,
      mode: 'submit',
      accept,
      label,
      fields: validatedFields,
      maxBytes: fileLimits?.maxBytes ?? null,
      maxFiles: fileLimits?.maxFiles ?? null,
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

  createReveal({ value, files, ttlMs = HANDOFF_DEFAULT_TTL_MS, label = 'Secure value' } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < HANDOFF_MIN_TTL_MS || ttlMs > HANDOFF_MAX_TTL_MS) {
      throw handoffError('invalid_ttl', 'TTL must be between 1 and 15 minutes');
    }
    if (typeof label !== 'string' || label.length < 1 || label.length > 100) {
      throw handoffError('invalid_label', 'Label must be between 1 and 100 characters');
    }
    // Exactly one payload: a text value (revealed on the page) or files
    // (downloaded once). Both together is ambiguous and rejected.
    if (files !== undefined && value !== undefined) {
      throw handoffError('invalid_value', 'Send either value or files, not both');
    }
    if (files !== undefined) {
      value = validatedRevealFiles(files);
    } else {
      if (typeof value !== 'string' || value.length === 0) throw handoffError('invalid_value', 'A value is required');
      if (Buffer.byteLength(value, 'utf8') > HANDOFF_MAX_VALUE_BYTES) {
        throw handoffError('value_too_large', 'Value exceeds the size limit');
      }
    }

    const id = this.randomBytes(16).toString('hex');
    const manageToken = this.randomBytes(32).toString('base64url');
    const csrfToken = this.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.sessions.set(id, {
      id,
      mode: 'reveal',
      revealFiles: typeof value === 'string' ? null : value.map(file => ({ filename: file.filename, size: file.data.length })),
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
      dropValue(session);
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
      accept: session.accept ?? null,
      label: session.label,
      expiresAt: session.expiresAt,
      fields: session.fields?.map(field => ({ ...field })) ?? null,
      maxBytes: session.maxBytes ?? null,
      maxFiles: session.maxFiles ?? null,
      // Names and sizes only: the preview never loads file content.
      files: session.revealFiles?.map(file => ({ ...file })) ?? null,
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
    session.value = validatedSubmission(session, value);
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
    dropValue(session);
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
        dropValue(session);
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
