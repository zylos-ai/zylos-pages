import crypto from 'node:crypto';

export const SHARE_PASSWORD_KDF_VERSION = 1;
export const SHARE_PASSWORD_MAX_BYTES = 1024;
export const DEFAULT_SHARE_PASSWORD_SCRYPT = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  saltBytes: 16,
  keyBytes: 32,
});

function passwordBuffer(password) {
  if (typeof password !== 'string') {
    throw Object.assign(new TypeError('Share password must be a string'), { code: 'invalid_password' });
  }
  const value = Buffer.from(password, 'utf8');
  if (value.length === 0 || value.length > SHARE_PASSWORD_MAX_BYTES) {
    throw Object.assign(new RangeError(`Share password must be 1-${SHARE_PASSWORD_MAX_BYTES} UTF-8 bytes`), {
      code: 'invalid_password',
    });
  }
  return value;
}

function normalizedParams(params = {}) {
  const merged = { ...DEFAULT_SHARE_PASSWORD_SCRYPT, ...params };
  for (const name of ['N', 'r', 'p', 'saltBytes', 'keyBytes']) {
    if (!Number.isSafeInteger(merged[name]) || merged[name] <= 0) {
      throw new TypeError(`Invalid scrypt ${name}`);
    }
  }
  if ((merged.N & (merged.N - 1)) !== 0 || merged.N < 2) {
    throw new TypeError('Invalid scrypt N');
  }
  if (merged.N > 262_144 || merged.r > 32 || merged.p > 16 ||
      merged.saltBytes < 16 || merged.saltBytes > 64 || merged.keyBytes !== 32) {
    throw new TypeError('Share password scrypt parameters exceed safe bounds');
  }
  return merged;
}

function scryptAsync(password, salt, params) {
  const maxmem = Math.max(32 * 1024 * 1024, 128 * params.N * params.r + 2 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keyBytes, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function encode({ N, r, p }, salt, digest) {
  return [
    'zylos-share-scrypt',
    `v=${SHARE_PASSWORD_KDF_VERSION}`,
    `N=${N},r=${r},p=${p}`,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

export function parseSharePasswordHash(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 512) return null;
  const parts = encoded.split('$');
  if (parts.length !== 5 || parts[0] !== 'zylos-share-scrypt' || parts[1] !== `v=${SHARE_PASSWORD_KDF_VERSION}`) {
    return null;
  }
  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[2]);
  if (!match) return null;
  let params;
  try {
    params = normalizedParams({
      N: Number(match[1]),
      r: Number(match[2]),
      p: Number(match[3]),
      saltBytes: 16,
      keyBytes: 32,
    });
  } catch {
    return null;
  }
  const salt = Buffer.from(parts[3], 'base64url');
  const digest = Buffer.from(parts[4], 'base64url');
  if (salt.length < 16 || salt.length > 64 || digest.length !== params.keyBytes) return null;
  if (salt.toString('base64url') !== parts[3] || digest.toString('base64url') !== parts[4]) return null;
  return { params, salt, digest };
}

export async function hashSharePassword(password, options = {}) {
  const value = passwordBuffer(password);
  const params = normalizedParams(options);
  const salt = options.salt ? Buffer.from(options.salt) : crypto.randomBytes(params.saltBytes);
  if (salt.length < 16 || salt.length > 64) throw new TypeError('Share password salt must be 16-64 bytes');
  const digest = await scryptAsync(value, salt, params);
  return encode(params, salt, digest);
}

export async function verifySharePassword(password, encoded) {
  let value;
  try {
    value = passwordBuffer(password);
  } catch {
    return false;
  }
  const parsed = parseSharePasswordHash(encoded);
  if (!parsed) return false;
  const digest = await scryptAsync(value, parsed.salt, parsed.params);
  return digest.length === parsed.digest.length && crypto.timingSafeEqual(digest, parsed.digest);
}
