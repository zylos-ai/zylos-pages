import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-coexist-'));
const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-coexist-content-'));
const custodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-share-coexist-keys-'));
process.env.PAGES_DATA_DIR = dataDir;

const express = (await import('express')).default;
const { setupShareApi } = await import('../src/routes/share-api.js');
const { setupAuth, hashPassword } = await import('../src/security/auth.js');
const {
  SHARE_ACCESS_COOKIE_BUDGET_BYTES,
  SHARE_ACCESS_COOKIE_LIMIT,
  createShare,
  createShareAccessCookie,
  parseShareAccessCookies,
} = await import('../src/sharing/share-manager.js');
const { createSharePasswordKeyring } = await import('../src/sharing/share-password-keyring.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');
const { getPagesDb } = await import('../src/db/pages-db.js');

const keyFile = path.join(custodyDir, 'keys.json');
createSharePasswordKeyring(keyFile, { keyId: 'test-key', key: Buffer.alloc(32, 0x51) });
const ownerPasswordHash = hashPassword('owner-secret');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.rmSync(custodyDir, { recursive: true, force: true });
});

function splitSetCookie(header) {
  return header ? header.split(/,\s*(?=__Secure-|__Host-)/) : [];
}

function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0];
}

function applySetCookies(jar, response) {
  for (const setCookie of splitSetCookie(response.headers.get('set-cookie'))) {
    const pair = cookiePair(setCookie);
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (/;\s*Max-Age=0(?:;|$)/i.test(setCookie) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function shareCookies(jar) {
  return [...jar].filter(([name]) => /^__Secure-share_access\.[a-f0-9]{32}$/.test(name));
}

function registerPage(uri) {
  const sourcePath = path.join(contentDir, `${uri.replaceAll('/', '-')}.md`);
  fs.writeFileSync(sourcePath, `# ${uri}\n\nprivate ${uri}\n`);
  registerLogicalPage({ uri, title: uri, sourcePath, component: 'content' }, {
    externalFiles: { allowedSources: { content: contentDir } },
  });
}

async function makeServer() {
  for (const uri of ['alpha', 'beta', ...Array.from({ length: 17 }, (_, i) => `budget-${i}`)]) {
    registerPage(uri);
  }
  const config = {
    contentDir,
    auth: { password: ownerPasswordHash },
    sharing: {
      enabled: true,
      passwordKeyFile: keyFile,
      passwordRateLimit: { windowMs: 60_000, tokenMax: 30, ipMax: 100 },
    },
    externalFiles: { allowedSources: { content: contentDir } },
    security: { allowRawHtml: false, maxFileSizeBytes: 1024 * 1024, renderTimeoutMs: 5000 },
    toc: { minHeadings: 3 },
    theme: { codeTheme: 'github-dark' },
  };
  const app = express();
  setupAuth(app, config.auth, config.sharing);
  setupShareApi(app, config.sharing, config);
  app.get('/p/:slug', (_req, res) => res.json({
    viewerType: res.locals.viewerType || null,
    tokenId: res.locals.shareContext?.tokenId || null,
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function login(origin, cookies = '') {
  const response = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: new URLSearchParams({ password: 'owner-secret' }),
  });
  assert.equal(response.status, 302);
  return response;
}

async function createProtected(origin, ownerCookie, uri, password) {
  const response = await fetch(`${origin}/api/share`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Forwarded-Proto': 'http',
      Cookie: ownerCookie,
    },
    body: JSON.stringify({
      slug: `p/${uri}`,
      duration: '24h',
      protection: { type: 'password', mode: 'provided', password },
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function unlock(origin, share, password, jar) {
  const response = await fetch(`${share.shortUrl}/unlock`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      ...(jar?.size ? { Cookie: cookieHeader(jar) } : {}),
    },
    body: new URLSearchParams({ password }),
  });
  assert.equal(response.status, 303);
  if (jar) applySetCookies(jar, response);
  return response;
}

test('independent protected shares coexist while authorization stays non-transitive', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const ownerCookie = cookieHeader(ownerJar);
    const shareA = await createProtected(origin, ownerCookie, 'alpha', 'alpha-secret');
    const shareB = await createProtected(origin, ownerCookie, 'beta', 'beta-secret');
    const jar = new Map();

    await unlock(origin, shareA, 'alpha-secret', jar);
    const [[nameA, valueA]] = shareCookies(jar);
    await unlock(origin, shareB, 'beta-secret', jar);
    assert.equal(shareCookies(jar).length, 2, 'unlocking B must preserve A');
    const [nameB, valueB] = shareCookies(jar).find(([name]) => name !== nameA);

    for (const url of [shareA.shortUrl, shareB.shortUrl, `${origin}/p/alpha`, `${origin}/p/beta`]) {
      const response = await fetch(url, { redirect: 'manual', headers: { Cookie: cookieHeader(jar) } });
      assert.equal(response.status, 200, `${url} should remain readable`);
      assert.equal(response.headers.get('x-zylos-share-error'), null);
    }

    let response = await fetch(shareB.shortUrl, {
      redirect: 'manual', headers: { Cookie: `${nameA}=${valueA}` },
    });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required', 'A cannot authorize B');
    response = await fetch(shareA.shortUrl, {
      redirect: 'manual', headers: { Cookie: `${nameB}=${valueB}` },
    });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required', 'B cannot authorize A');
  } finally {
    server.close();
  }
});

test('duplicate and malformed recognized cookies fail closed while stale siblings do not mask a valid grant', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const share = await createProtected(origin, cookieHeader(ownerJar), 'alpha', 'alpha-secret');
    const jar = new Map();
    await unlock(origin, share, 'alpha-secret', jar);
    const [[name, value]] = shareCookies(jar);

    let response = await fetch(share.shortUrl, {
      redirect: 'manual', headers: { Cookie: `${name}=${value}; ${name}=${value}` },
    });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
    assert.match(response.headers.get('set-cookie'), new RegExp(`${name.replace('.', '\\.')}=;`));

    const staleName = `__Secure-share_access.${'f'.repeat(32)}`;
    response = await fetch(share.shortUrl, {
      redirect: 'manual',
      headers: { Cookie: `${name}=${value}; ${staleName}=${'e'.repeat(64)}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-zylos-share-error'), null);
    assert.match(response.headers.get('set-cookie'), new RegExp(`${staleName.replace('.', '\\.')}=;`));

    response = await fetch(share.shortUrl, {
      redirect: 'manual', headers: { Cookie: `${name}=not-hex` },
    });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');

    response = await fetch(share.shortUrl, {
      redirect: 'manual',
      headers: {
        Cookie: `${name}=not-hex`,
        'X-Zylos-Share-Password': 'alpha-secret',
      },
    });
    assert.equal(response.status, 200, 'a direct password remains a valid independent proof');
    assert.match(response.headers.get('set-cookie'), new RegExp(`${name.replace('.', '\\.')}=;`));
  } finally {
    server.close();
  }
});

test('recognized-cookie budgets include the legacy singleton during migration', () => {
  const named = Array.from({ length: SHARE_ACCESS_COOKIE_LIMIT }, (_, index) =>
    `__Secure-share_access.${index.toString(16).padStart(32, '0')}=${'a'.repeat(64)}`);
  const legacy = `__Secure-share_access=${'b'.repeat(64)}`;

  const atLimit = parseShareAccessCookies([...named.slice(0, -1), legacy].join('; '));
  assert.equal(atLimit.recognizedNames.length, SHARE_ACCESS_COOKIE_LIMIT);
  assert.equal(atLimit.valid, true);
  assert.equal(atLimit.recognizedBytes, Buffer.byteLength([...named.slice(0, -1), legacy].join('; ')));

  const overLimit = parseShareAccessCookies([...named, legacy].join('; '));
  assert.equal(overLimit.recognizedNames.length, SHARE_ACCESS_COOKIE_LIMIT + 1);
  assert.equal(overLimit.overBudget, true);
  assert.equal(overLimit.valid, false);
});

test('same-page share lifecycle changes invalidate only the affected browser grant', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const ownerCookie = cookieHeader(ownerJar);
    const shareA = await createProtected(origin, ownerCookie, 'alpha', 'alpha-secret');
    const shareB = await createProtected(origin, ownerCookie, 'alpha', 'beta-secret');
    const jar = new Map();

    await unlock(origin, shareA, 'alpha-secret', jar);
    const nameA = shareCookies(jar)[0][0];
    await unlock(origin, shareB, 'beta-secret', jar);
    const nameB = shareCookies(jar).find(([name]) => name !== nameA)[0];

    let response = await fetch(`${origin}/api/share/${shareA.tokenId}/password/rotate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Cookie: ownerCookie,
      },
      body: JSON.stringify({ mode: 'provided', password: 'alpha-rotated' }),
    });
    assert.equal(response.status, 200);

    response = await fetch(shareA.shortUrl, { headers: { Cookie: cookieHeader(jar) } });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
    response = await fetch(shareB.shortUrl, { headers: { Cookie: cookieHeader(jar) } });
    assert.equal(response.status, 200, 'rotating A must preserve B');
    assert.equal(response.headers.get('x-zylos-share-error'), null);

    await unlock(origin, shareA, 'alpha-rotated', jar);
    assert.equal(jar.has(nameA), false, 're-unlock must replace only A\'s stale slot');
    assert.equal(jar.has(nameB), true, 're-unlock A must not overwrite B');
    assert.equal(shareCookies(jar).length, 2);

    response = await fetch(`${origin}/api/share/${shareB.tokenId}`, {
      method: 'DELETE',
      headers: { Origin: origin, Cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    response = await fetch(shareA.shortUrl, { headers: { Cookie: cookieHeader(jar) } });
    assert.equal(response.status, 200, 'revoking B must preserve A');
    response = await fetch(shareB.shortUrl, { redirect: 'manual', headers: { Cookie: cookieHeader(jar) } });
    assert.equal(response.status, 404);
  } finally {
    server.close();
  }
});

test('server-session expiry prunes only the expired grant while a valid sibling survives', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const ownerCookie = cookieHeader(ownerJar);
    const shareA = await createProtected(origin, ownerCookie, 'alpha', 'alpha-secret');
    const shareB = await createProtected(origin, ownerCookie, 'beta', 'beta-secret');
    const jar = new Map();

    await unlock(origin, shareA, 'alpha-secret', jar);
    const nameA = shareCookies(jar)[0][0];
    await unlock(origin, shareB, 'beta-secret', jar);
    getPagesDb().prepare('UPDATE share_sessions SET expires_at = 0 WHERE cookie_id = ?')
      .run(nameA.slice('__Secure-share_access.'.length));

    let response = await fetch(shareA.shortUrl, { headers: { Cookie: cookieHeader(jar) } });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required');
    assert.match(response.headers.get('set-cookie'), new RegExp(`${nameA.replace('.', '\\.')}=;`));

    response = await fetch(shareB.shortUrl, { headers: { Cookie: cookieHeader(jar) } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-zylos-share-error'), null);
  } finally {
    server.close();
  }
});

test('legacy singleton rotates on use and is preserved as a sibling when another share unlocks', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const ownerCookie = cookieHeader(ownerJar);
    const shareA = await createProtected(origin, ownerCookie, 'alpha', 'alpha-secret');
    const shareB = await createProtected(origin, ownerCookie, 'beta', 'beta-secret');

    const pageA = getPagesDb().prepare('SELECT page_id, credential_version FROM shares WHERE token_id = ?')
      .get(shareA.tokenId);
    const issued = createShareAccessCookie(
      pageA.page_id, shareA.tokenId, shareA.expiresAt, '/', pageA.credential_version,
    );
    getPagesDb().prepare('UPDATE share_sessions SET cookie_id = NULL WHERE cookie_id = ?')
      .run(issued.name.slice('__Secure-share_access.'.length));
    const legacyJar = new Map([['__Secure-share_access', issued.value]]);

    let response = await fetch(shareA.shortUrl, {
      redirect: 'manual', headers: { Cookie: cookieHeader(legacyJar) },
    });
    assert.equal(response.status, 200);
    applySetCookies(legacyJar, response);
    assert.equal(legacyJar.has('__Secure-share_access'), false);
    assert.equal(shareCookies(legacyJar).length, 1);

    response = await fetch(shareA.shortUrl, {
      redirect: 'manual', headers: { Cookie: `__Secure-share_access=${issued.value}` },
    });
    assert.equal(response.headers.get('x-zylos-share-error'), 'password_required', 'rotated singleton cannot be replayed');

    // Seed another old-form A session, then unlock B. The response must migrate
    // A into a named cookie while also adding B, rather than discarding A.
    const secondLegacy = createShareAccessCookie(
      pageA.page_id, shareA.tokenId, shareA.expiresAt, '/', pageA.credential_version,
    );
    getPagesDb().prepare('UPDATE share_sessions SET cookie_id = NULL WHERE cookie_id = ?')
      .run(secondLegacy.name.slice('__Secure-share_access.'.length));
    const combined = new Map([['__Secure-share_access', secondLegacy.value]]);
    await unlock(origin, shareB, 'beta-secret', combined);
    assert.equal(shareCookies(combined).length, 2);
    for (const target of [shareA.shortUrl, shareB.shortUrl]) {
      response = await fetch(target, { headers: { Cookie: cookieHeader(combined) } });
      assert.equal(response.headers.get('x-zylos-share-error'), null);
    }
  } finally {
    server.close();
  }
});

test('the 17th grant evicts the deterministic LRU row and oversized input is cleaned before issue', async () => {
  const { server, origin } = await makeServer();
  try {
    assert.equal(SHARE_ACCESS_COOKIE_LIMIT, 16);
    assert.equal(SHARE_ACCESS_COOKIE_BUDGET_BYTES, 4096);
    const jar = new Map();
    const issued = [];
    for (let i = 0; i < 16; i += 1) {
      const share = createShare(`budget-${i}`, '24h');
      const response = await fetch(`${origin}/s/${share.tokenId}`, {
        headers: jar.size ? { Cookie: cookieHeader(jar) } : {},
      });
      applySetCookies(jar, response);
      issued.push({ share, name: shareCookies(jar).find(([name]) => !issued.some(item => item.name === name))[0] });
    }
    assert.equal(shareCookies(jar).length, 16);

    const db = getPagesDb();
    for (let i = 0; i < issued.length; i += 1) {
      db.prepare('UPDATE share_sessions SET last_activity_at = ? WHERE cookie_id = ?')
        .run(10_000 + i, issued[i].name.slice('__Secure-share_access.'.length));
    }
    // Make index 0 recently used and index 1 the deterministic LRU victim.
    db.prepare('UPDATE share_sessions SET last_activity_at = ? WHERE cookie_id = ?')
      .run(99_999, issued[0].name.slice('__Secure-share_access.'.length));

    const seventeenth = createShare('budget-16', '24h');
    const response = await fetch(`${origin}/s/${seventeenth.tokenId}`, {
      headers: { Cookie: cookieHeader(jar) },
    });
    assert.match(response.headers.get('set-cookie'), new RegExp(`${issued[1].name.replace('.', '\\.')}=;`));
    applySetCookies(jar, response);
    assert.equal(shareCookies(jar).length, 16);
    assert.equal(jar.has(issued[0].name), true);
    assert.equal(jar.has(issued[1].name), false);
    assert.equal(db.prepare('SELECT 1 FROM share_sessions WHERE cookie_id = ?')
      .get(issued[1].name.slice('__Secure-share_access.'.length)), undefined);

    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const protectedShare = await createProtected(origin, cookieHeader(ownerJar), 'alpha', 'alpha-secret');
    const oversizedName = `__Secure-share_access.${'d'.repeat(32)}`;
    const oversizedJar = new Map([[oversizedName, 'c'.repeat(SHARE_ACCESS_COOKIE_BUDGET_BYTES + 1)]]);
    const unlockResponse = await unlock(origin, protectedShare, 'alpha-secret', oversizedJar);
    assert.match(unlockResponse.headers.get('set-cookie'), new RegExp(`${oversizedName.replace('.', '\\.')}=;`));
    assert.equal(shareCookies(oversizedJar).length, 1);
    assert.equal(oversizedJar.has(oversizedName), false);
  } finally {
    server.close();
  }
});

test('successful owner login and logout clear every presented per-share cookie plus singleton', async () => {
  const { server, origin } = await makeServer();
  try {
    const ownerJar = new Map();
    applySetCookies(ownerJar, await login(origin));
    const ownerCookie = cookieHeader(ownerJar);
    const shareA = await createProtected(origin, ownerCookie, 'alpha', 'alpha-secret');
    const shareB = await createProtected(origin, ownerCookie, 'beta', 'beta-secret');
    const shareJar = new Map();
    await unlock(origin, shareA, 'alpha-secret', shareJar);
    await unlock(origin, shareB, 'beta-secret', shareJar);
    shareJar.set('__Secure-share_access', 'a'.repeat(64));
    const names = [...shareJar.keys()];

    let response = await login(origin, cookieHeader(shareJar));
    const setCookie = response.headers.get('set-cookie');
    for (const name of names) assert.match(setCookie, new RegExp(`${name.replace('.', '\\.')}=;`));
    applySetCookies(shareJar, response);
    assert.equal(shareCookies(shareJar).length, 0);
    assert.equal(shareJar.has('__Secure-share_access'), false);

    // Re-present the grants alongside the live owner session to exercise the
    // logout path independently from the browser-side login deletion.
    const logoutJar = new Map(shareCookies(new Map(names
      .filter(name => name.includes('.'))
      .map(name => [name, 'b'.repeat(64)]))));
    for (const [name, value] of ownerJar) logoutJar.set(name, value);
    logoutJar.set('__Secure-share_access', 'a'.repeat(64));
    response = await fetch(`${origin}/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Origin: origin, Cookie: cookieHeader(logoutJar) },
    });
    assert.equal(response.status, 302);
    const logoutSetCookie = response.headers.get('set-cookie');
    for (const name of logoutJar.keys()) {
      if (name.startsWith('__Secure-share_access')) {
        assert.match(logoutSetCookie, new RegExp(`${name.replace('.', '\\.')}=;`));
      }
    }
  } finally {
    server.close();
  }
});
