import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SHARE_PASSWORD_SCRYPT,
  SHARE_PASSWORD_MAX_BYTES,
  hashSharePassword,
  parseSharePasswordHash,
  verifySharePassword,
} from '../src/security/share-password-kdf.js';
import { SharePasswordRateLimiter } from '../src/security/share-password-rate-limit.js';
import { generateSharePassword } from '../src/sharing/share-password-crypto.js';

test('generated share passwords are exactly 8 numeric digits, leading zeros preserved', () => {
  const generated = Array.from({ length: 64 }, () => generateSharePassword());
  for (const password of generated) {
    assert.match(password, /^[0-9]{8}$/);
    assert.ok(Buffer.byteLength(password, 'utf8') >= 8, 'must satisfy the provided-password minimum');
  }
  assert.ok(new Set(generated).size > 32, 'generator must draw from the full space, not a degenerate range');
});

test('share password hashes are self-describing and verify asynchronously', async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const encoded = await hashSharePassword('correct horse battery staple');
    const parsed = parseSharePasswordHash(encoded);
    assert.ok(parsed);
    assert.equal(parsed.params.N, DEFAULT_SHARE_PASSWORD_SCRYPT.N);
    assert.equal(parsed.params.r, DEFAULT_SHARE_PASSWORD_SCRYPT.r);
    assert.equal(parsed.params.p, DEFAULT_SHARE_PASSWORD_SCRYPT.p);
    assert.equal(await verifySharePassword('correct horse battery staple', encoded), true);
    assert.equal(await verifySharePassword('wrong', encoded), false);
    assert.ok(ticks > 0, 'the event loop must keep advancing while scrypt runs');
  } finally {
    clearInterval(timer);
  }
});

test('malformed encodings and oversized input fail before KDF work', async () => {
  assert.equal(parseSharePasswordHash('not-a-hash'), null);
  assert.equal(parseSharePasswordHash(`zylos-share-scrypt$v=1$N=1073741824,r=8,p=1$${'a'.repeat(22)}$${'b'.repeat(43)}`), null);
  assert.equal(await verifySharePassword('secret', 'not-a-hash'), false);
  await assert.rejects(
    hashSharePassword('x'.repeat(SHARE_PASSWORD_MAX_BYTES + 1)),
    error => error.code === 'invalid_password',
  );
});

test('dual token/IP limiter can reject before the KDF is invoked', async () => {
  const limiter = new SharePasswordRateLimiter({ tokenMax: 1, ipMax: 2 });
  let kdfCalls = 0;
  async function guardedVerify() {
    const budget = limiter.consume({ tokenId: 'a'.repeat(32), clientIp: '192.0.2.1' });
    if (!budget.allowed) return 'rate_limited';
    kdfCalls += 1;
    return hashSharePassword('secret');
  }
  assert.match(await guardedVerify(), /^zylos-share-scrypt\$/);
  assert.equal(await guardedVerify(), 'rate_limited');
  assert.equal(kdfCalls, 1, 'exhausted budget must prevent a second KDF call');
});
