import crypto from 'node:crypto';
import { hashSharePassword } from '../security/share-password-kdf.js';

const FORMAT_VERSION = 1;
const GENERATED_PASSWORD_DIGITS = 8;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = Buffer.from('zylos-pages/share-password/v1', 'utf8');

function requireIdentity({ tokenId, pageId, credentialVersion, keyId }) {
  if (!/^[a-f0-9]{32}$/.test(tokenId || '') || typeof pageId !== 'string' || !pageId ||
      !Number.isSafeInteger(credentialVersion) || credentialVersion < 0 || typeof keyId !== 'string' || !keyId) {
    throw new TypeError('Invalid share password cryptographic identity');
  }
}

function aad(identity) {
  requireIdentity(identity);
  return Buffer.from(JSON.stringify({
    formatVersion: FORMAT_VERSION,
    tokenId: identity.tokenId,
    pageId: identity.pageId,
    credentialVersion: identity.credentialVersion,
    keyId: identity.keyId,
  }), 'utf8');
}

function deriveDataKey(masterKey, tokenId) {
  const key = Buffer.from(masterKey);
  if (key.length !== 32) throw new TypeError('Share password master key must be 32 bytes');
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from(tokenId, 'hex'), HKDF_INFO, 32));
}

// 8 numeric digits: easy to type/relay in chat, and brute force is bounded by
// the pre-KDF rate limiter rather than password entropy (see issue 8dde265b).
export function generateSharePassword() {
  return String(crypto.randomInt(0, 10 ** GENERATED_PASSWORD_DIGITS)).padStart(GENERATED_PASSWORD_DIGITS, '0');
}

export function encryptSharePassword(password, identity, masterKey, { nonce = crypto.randomBytes(NONCE_BYTES) } = {}) {
  if (typeof password !== 'string' || Buffer.from(password, 'utf8').length === 0) throw new TypeError('Invalid share password');
  const nonceBuffer = Buffer.from(nonce);
  if (nonceBuffer.length !== NONCE_BYTES) throw new TypeError('Invalid share password nonce');
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveDataKey(masterKey, identity.tokenId), nonceBuffer);
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, nonce: nonceBuffer };
}

export function decryptSharePassword({ ciphertext, nonce }, identity, masterKey) {
  const encrypted = Buffer.from(ciphertext);
  const nonceBuffer = Buffer.from(nonce);
  if (encrypted.length <= TAG_BYTES || nonceBuffer.length !== NONCE_BYTES) {
    throw Object.assign(new Error('Malformed encrypted share password'), { code: 'password_decryption_failed' });
  }
  try {
    const body = encrypted.subarray(0, -TAG_BYTES);
    const tag = encrypted.subarray(-TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveDataKey(masterKey, identity.tokenId), nonceBuffer);
    decipher.setAAD(aad(identity));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch (error) {
    throw Object.assign(new Error('Could not decrypt share password', { cause: error }), {
      code: 'password_decryption_failed',
    });
  }
}

export async function buildSharePasswordCredential(password, identity, keyring, { kdf = {} } = {}) {
  const keyId = keyring?.activeKeyId;
  const masterKey = keyring?.keys?.get(keyId);
  if (!masterKey) throw Object.assign(new Error('Active share password key is unavailable'), {
    code: 'password_custody_unavailable',
  });
  const boundIdentity = { ...identity, keyId };
  const [passwordHash, encrypted] = await Promise.all([
    hashSharePassword(password, kdf),
    Promise.resolve(encryptSharePassword(password, boundIdentity, masterKey)),
  ]);
  return {
    passwordHash,
    passwordCiphertext: encrypted.ciphertext,
    passwordNonce: encrypted.nonce,
    passwordKeyId: keyId,
    credentialVersion: identity.credentialVersion,
  };
}

export function revealSharePassword(credential, identity, keyring) {
  const masterKey = keyring?.keys?.get(credential.passwordKeyId);
  if (!masterKey) throw Object.assign(new Error('Referenced share password key is unavailable'), {
    code: 'password_custody_unavailable',
  });
  return decryptSharePassword({
    ciphertext: credential.passwordCiphertext,
    nonce: credential.passwordNonce,
  }, { ...identity, keyId: credential.passwordKeyId }, masterKey);
}
