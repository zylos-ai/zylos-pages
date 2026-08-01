import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  defaultSharePasswordKeyFile,
  ensureSharePasswordKeyring,
} from '../hooks/ensure-share-password-keyring.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeHome(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-hook-'));
  const dataDir = path.join(home, 'zylos/components/pages');
  fs.mkdirSync(dataDir, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  }
  return home;
}

function readConfig(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'zylos/components/pages/config.json'), 'utf8'));
}

function capture() {
  const lines = [];
  return { lines, sink: (message) => lines.push(message) };
}

function withoutKeyFileEnv(run) {
  const saved = process.env.PAGES_SHARE_PASSWORD_KEY_FILE;
  delete process.env.PAGES_SHARE_PASSWORD_KEY_FILE;
  try {
    return run();
  } finally {
    if (saved !== undefined) process.env.PAGES_SHARE_PASSWORD_KEY_FILE = saved;
  }
}

test('unconfigured custody gets a default keyring and config pointer', () => withoutKeyFileEnv(() => {
  const home = makeHome({ sharing: { enabled: true } });
  const keyFile = defaultSharePasswordKeyFile(home);
  assert.equal(fs.existsSync(keyFile), false);

  const log = capture();
  const result = ensureSharePasswordKeyring({ home, log: log.sink, warn: log.sink });
  assert.equal(result.status, 'created');
  assert.equal(result.keyFile, keyFile);

  assert.equal(readConfig(home).sharing.passwordKeyFile, keyFile);
  assert.equal(readConfig(home).sharing.enabled, true);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const envelope = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  assert.equal(envelope.formatVersion, 1);
  assert.equal(result.activeKeyId, envelope.activeKeyId);
  assert.ok(envelope.keys[envelope.activeKeyId]);
}));

test('second run is idempotent and leaves the keyring bytes untouched', () => withoutKeyFileEnv(() => {
  const home = makeHome({ sharing: { enabled: true } });
  const first = ensureSharePasswordKeyring({ home, log: () => {}, warn: () => {} });
  assert.equal(first.status, 'created');
  const before = fs.readFileSync(first.keyFile);

  const second = ensureSharePasswordKeyring({ home, log: () => {}, warn: () => {} });
  assert.equal(second.status, 'exists');
  assert.deepEqual(fs.readFileSync(first.keyFile), before);
}));

test('explicitly configured keyring that exists is left alone', () => withoutKeyFileEnv(() => {
  const home = makeHome();
  const keyFile = path.join(home, 'custom-keys.json');
  fs.writeFileSync(keyFile, 'operator-managed');
  fs.mkdirSync(path.join(home, 'zylos/components/pages'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'zylos/components/pages/config.json'),
    JSON.stringify({ sharing: { passwordKeyFile: keyFile } }),
  );

  const result = ensureSharePasswordKeyring({ home, log: () => {}, warn: () => {} });
  assert.equal(result.status, 'exists');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'operator-managed');
}));

test('explicitly configured but missing keyring fails closed with a warning', () => withoutKeyFileEnv(() => {
  const home = makeHome();
  const keyFile = path.join(home, 'lost-keys.json');
  fs.writeFileSync(
    path.join(home, 'zylos/components/pages/config.json'),
    JSON.stringify({ sharing: { passwordKeyFile: keyFile } }),
  );

  const warned = capture();
  const result = ensureSharePasswordKeyring({ home, log: () => {}, warn: warned.sink });
  assert.equal(result.status, 'missing_configured');
  assert.equal(fs.existsSync(keyFile), false);
  assert.match(warned.lines.join('\n'), /Not auto-creating/);
  // Config must not be rewritten with a default path over the operator's one.
  assert.equal(readConfig(home).sharing.passwordKeyFile, keyFile);
}));

test('PAGES_SHARE_PASSWORD_KEY_FILE env counts as explicit configuration', () => {
  const home = makeHome({ sharing: { enabled: true } });
  const saved = process.env.PAGES_SHARE_PASSWORD_KEY_FILE;
  process.env.PAGES_SHARE_PASSWORD_KEY_FILE = path.join(home, 'env-keys.json');
  try {
    const warned = capture();
    const result = ensureSharePasswordKeyring({ home, log: () => {}, warn: warned.sink });
    assert.equal(result.status, 'missing_configured');
    assert.equal(fs.existsSync(path.join(home, 'env-keys.json')), false);
    assert.equal(readConfig(home).sharing.passwordKeyFile, undefined);
  } finally {
    if (saved === undefined) delete process.env.PAGES_SHARE_PASSWORD_KEY_FILE;
    else process.env.PAGES_SHARE_PASSWORD_KEY_FILE = saved;
  }
});

test('a transient creation failure stays retryable: no config pointer is left behind', () => withoutKeyFileEnv(() => {
  const home = makeHome({ sharing: { enabled: true } });
  // Occupy the vault path with a file so the keyring directory cannot be made.
  fs.mkdirSync(path.join(home, 'zylos'), { recursive: true });
  fs.writeFileSync(path.join(home, 'zylos/vault'), 'not a directory');

  const warned = capture();
  const first = ensureSharePasswordKeyring({ home, log: () => {}, warn: warned.sink });
  assert.equal(first.status, 'error');
  assert.match(warned.lines.join('\n'), /keyring setup failed/);
  // The failed run must not leave a pointer that a later run would mistake
  // for operator configuration (which would trip fail-closed forever).
  assert.equal(readConfig(home).sharing.passwordKeyFile, undefined);

  // Obstacle removed: the next run must self-heal, not report missing_configured.
  fs.unlinkSync(path.join(home, 'zylos/vault'));
  const second = ensureSharePasswordKeyring({ home, log: () => {}, warn: () => {} });
  assert.equal(second.status, 'created');
  assert.equal(fs.statSync(second.keyFile).mode & 0o777, 0o600);
  assert.equal(readConfig(home).sharing.passwordKeyFile, second.keyFile);
}));

test('a valid default keyring left by a half-completed run is adopted', () => withoutKeyFileEnv(() => {
  const home = makeHome({ sharing: { enabled: true } });
  // Simulate "keyring created but config write failed": keyring present at the
  // default path, config has no pointer.
  const keyFile = defaultSharePasswordKeyFile(home);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const seeded = ensureSharePasswordKeyring({ home, log: () => {}, warn: () => {} });
  assert.equal(seeded.status, 'created');
  const config = readConfig(home);
  delete config.sharing.passwordKeyFile;
  fs.writeFileSync(path.join(home, 'zylos/components/pages/config.json'), JSON.stringify(config, null, 2));
  const before = fs.readFileSync(keyFile);

  const result = ensureSharePasswordKeyring({ home, log: () => {}, warn: () => {} });
  assert.equal(result.status, 'adopted');
  assert.equal(readConfig(home).sharing.passwordKeyFile, keyFile);
  assert.deepEqual(fs.readFileSync(keyFile), before);
}));

test('an invalid file at the default path is not adopted and config stays unchanged', () => withoutKeyFileEnv(() => {
  const home = makeHome({ sharing: { enabled: true } });
  const keyFile = defaultSharePasswordKeyFile(home);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, 'not a keyring', { mode: 0o600 });

  const warned = capture();
  const result = ensureSharePasswordKeyring({ home, log: () => {}, warn: warned.sink });
  assert.equal(result.status, 'error');
  assert.match(warned.lines.join('\n'), /keyring setup failed/);
  assert.equal(readConfig(home).sharing.passwordKeyFile, undefined);
}));

test('post-upgrade hook initializes the keyring end to end', () => {
  const home = makeHome({ sharing: { enabled: true } });
  const stdout = execFileSync(process.execPath, [path.join(repoRoot, 'hooks/post-upgrade.js')], {
    env: { ...process.env, HOME: home, PAGES_SHARE_PASSWORD_KEY_FILE: '' },
    encoding: 'utf8',
  });
  assert.match(stdout, /keyring initialized/);
  const keyFile = defaultSharePasswordKeyFile(home);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(readConfig(home).sharing.passwordKeyFile, keyFile);
});

test('post-install hook initializes the keyring end to end', () => {
  const home = makeHome();
  fs.mkdirSync(path.join(home, 'zylos/http/public/pages'), { recursive: true });
  const stdout = execFileSync(process.execPath, [path.join(repoRoot, 'hooks/post-install.js')], {
    env: { ...process.env, HOME: home, PAGES_SHARE_PASSWORD_KEY_FILE: '' },
    encoding: 'utf8',
  });
  assert.match(stdout, /keyring initialized/);
  const keyFile = defaultSharePasswordKeyFile(home);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(readConfig(home).sharing.passwordKeyFile, keyFile);
});
