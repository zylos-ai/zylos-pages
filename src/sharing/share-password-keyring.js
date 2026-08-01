import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SHARE_PASSWORD_KEYRING_FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const MAX_KEYRING_BYTES = 1024 * 1024;
const MAX_KEYS = 128;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function custodyError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'password_custody_unavailable',
  });
}

function canonicalKey(value) {
  if (typeof value !== 'string') return null;
  const key = Buffer.from(value, 'base64url');
  if (key.length !== KEY_BYTES || key.toString('base64url') !== value) return null;
  return key;
}

function validateEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw custodyError('Malformed share password keyring');
  if (raw.formatVersion !== SHARE_PASSWORD_KEYRING_FORMAT_VERSION) {
    throw custodyError(`Unsupported share password keyring format: ${raw.formatVersion}`);
  }
  if (!KEY_ID_PATTERN.test(raw.activeKeyId || '')) throw custodyError('Malformed active share password key id');
  if (!raw.keys || typeof raw.keys !== 'object' || Array.isArray(raw.keys)) {
    throw custodyError('Malformed share password key map');
  }
  if (Object.keys(raw.keys).length < 1 || Object.keys(raw.keys).length > MAX_KEYS) {
    throw custodyError('Share password keyring has an invalid key count');
  }
  const keys = new Map();
  for (const [keyId, encoded] of Object.entries(raw.keys)) {
    const key = canonicalKey(encoded);
    if (!KEY_ID_PATTERN.test(keyId) || !key) throw custodyError(`Malformed share password key: ${keyId}`);
    keys.set(keyId, key);
  }
  if (!keys.has(raw.activeKeyId)) throw custodyError('Active share password key is missing');
  return { formatVersion: raw.formatVersion, activeKeyId: raw.activeKeyId, keys };
}

function assertSafeFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw custodyError('Share password keyring is unavailable', error);
  }
  if (!stat.isFile() || stat.size > MAX_KEYRING_BYTES || (stat.mode & 0o077) !== 0) {
    throw custodyError('Share password keyring must be a regular 0600 file');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw custodyError('Share password keyring must be owned by the Pages service account');
  }
}

export function resolveSharePasswordKeyFile(config = {}) {
  const configured = process.env.PAGES_SHARE_PASSWORD_KEY_FILE || config.sharing?.passwordKeyFile;
  if (!configured || typeof configured !== 'string') return null;
  if (configured === '~') return process.env.HOME;
  if (configured.startsWith('~/')) return path.join(process.env.HOME, configured.slice(2));
  return path.resolve(configured);
}

export function loadSharePasswordKeyring(filePath) {
  if (!filePath) throw custodyError('Share password keyring path is not configured');
  assertSafeFile(filePath);
  try {
    return validateEnvelope(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error.code === 'password_custody_unavailable') throw error;
    throw custodyError('Share password keyring is malformed', error);
  }
}

function serializableKeyring(keyring) {
  return {
    formatVersion: SHARE_PASSWORD_KEYRING_FORMAT_VERSION,
    activeKeyId: keyring.activeKeyId,
    keys: Object.fromEntries([...keyring.keys].map(([keyId, key]) => [keyId, Buffer.from(key).toString('base64url')])),
  };
}

export function writeSharePasswordKeyringAtomic(filePath, keyring, { exclusive = false } = {}) {
  const validated = validateEnvelope(serializableKeyring(keyring));
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (exclusive && fs.existsSync(filePath)) throw custodyError('Share password keyring already exists');
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(serializableKeyring(validated), null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    try {
      const dirFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
    }
    return loadSharePasswordKeyring(filePath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch {}
    if (error.code === 'password_custody_unavailable') throw error;
    throw custodyError('Could not write share password keyring atomically', error);
  }
}

function newKeyId() {
  return `key-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

export function createSharePasswordKeyring(filePath, { keyId = newKeyId(), key = crypto.randomBytes(KEY_BYTES) } = {}) {
  if (!KEY_ID_PATTERN.test(keyId) || Buffer.from(key).length !== KEY_BYTES) throw new TypeError('Invalid share password key');
  return writeSharePasswordKeyringAtomic(filePath, {
    activeKeyId: keyId,
    keys: new Map([[keyId, Buffer.from(key)]]),
  }, { exclusive: true });
}

export function rotateSharePasswordKeyring(filePath, { keyId = newKeyId(), key = crypto.randomBytes(KEY_BYTES) } = {}) {
  const keyring = loadSharePasswordKeyring(filePath);
  if (!KEY_ID_PATTERN.test(keyId) || keyring.keys.has(keyId) || Buffer.from(key).length !== KEY_BYTES) {
    throw new TypeError('Invalid or duplicate share password key');
  }
  keyring.keys.set(keyId, Buffer.from(key));
  keyring.activeKeyId = keyId;
  return writeSharePasswordKeyringAtomic(filePath, keyring);
}

export function retireSharePasswordKey(filePath, keyId, referencedKeyIds = []) {
  const keyring = loadSharePasswordKeyring(filePath);
  if (keyId === keyring.activeKeyId) throw custodyError('Cannot retire the active share password key');
  if (new Set(referencedKeyIds).has(keyId)) throw custodyError('Cannot retire a referenced share password key');
  if (!keyring.keys.delete(keyId)) throw custodyError('Share password key does not exist');
  return writeSharePasswordKeyringAtomic(filePath, keyring);
}
