import crypto from 'node:crypto';
import { normalizeSlug } from '../utils/slug.js';

const OWNER_ASSET_MAX_AGE_MS = 5 * 60_000;

function signingSecret(config) {
  const secret = config?.auth?.password;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('Owner asset signing requires configured authentication');
  }
  return secret;
}

function signature({ uri, realPath, expiresAt, config }) {
  return crypto.createHmac('sha256', signingSecret(config))
    .update(`${normalizeSlug(uri)}|${realPath}|${expiresAt}|owner`)
    .digest('hex');
}

export function ownerAssetExpiresAt(now = Date.now()) {
  return now + OWNER_ASSET_MAX_AGE_MS;
}

export function createOwnerAssetSignature(input) {
  if (!Number.isSafeInteger(input.expiresAt)) {
    throw new Error('Invalid owner asset signature input');
  }
  return signature(input);
}

export function verifyOwnerAssetSignature(input, now = Date.now()) {
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || typeof input.sig !== 'string') {
    return false;
  }
  const expected = Buffer.from(signature(input), 'hex');
  const actual = Buffer.from(input.sig, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
