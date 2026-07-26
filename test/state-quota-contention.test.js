import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertIsolatedPagesDataDir } from './helpers/assert-isolated-data-dir.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-quota-data-'));
process.env.PAGES_DATA_DIR = dataDir;
assertIsolatedPagesDataDir(dataDir);

const { getPagesDb } = await import('../src/db/pages-db.js');
const { registerLogicalPage } = await import('../src/pages/page-store.js');
const { getStateValue, initStateStore, setStateValueWithinQuota } =
  await import('../src/state/state-store.js');

const contentDir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-state-quota-content-'));
const dbPath = path.join(dataDir, 'pages.db');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOLDER = `
const Database = require(${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3'))});
const { HOLD_DB, HOLD_MS, HOLD_PAGE, HOLD_KEY, HOLD_VALUE } = process.env;
const db = new Database(HOLD_DB);
db.pragma('journal_mode = WAL');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO artifact_state (page_id, key, value, updated_at) VALUES (?, ?, ?, ?)')
  .run(HOLD_PAGE, HOLD_KEY, HOLD_VALUE, 'held');
require('fs').writeSync(1, 'holding\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(HOLD_MS));
db.exec('COMMIT');
db.close();
`;

async function holdWriteLock({ holdMs, pageId, key, value }) {
  const child = spawn(process.execPath, ['-e', HOLDER], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      HOLD_DB: dbPath,
      HOLD_MS: String(holdMs),
      HOLD_PAGE: pageId,
      HOLD_KEY: key,
      HOLD_VALUE: JSON.stringify(value),
    },
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => {
      String(chunk).includes('holding') ? resolve() : reject(new Error(`unexpected: ${chunk}`));
    });
    child.once('error', reject);
  });
  return { exited };
}

async function makePage(uri) {
  const sourcePath = path.join(contentDir, `${uri}.html`);
  await writeFile(sourcePath, '<!doctype html><h1>x</h1>');
  return registerLogicalPage(
    { uri, title: uri, sourcePath, component: 'content' },
    { contentDir, externalFiles: { allowedSources: { content: contentDir } } }
  );
}

initStateStore();
const db = getPagesDb();

const waited = await makePage('state-quota-waits');
const holdMs = 600;
const holder = await holdWriteLock({ holdMs, pageId: waited.pageId, key: 'held', value: 'held' });
const startedAt = process.hrtime.bigint();
let admitted = null;
let refused = null;
try {
  // "held" is 6 UTF-8 JSON bytes and "x" is 3, so the serialized total seen
  // after the lock is released must refuse this under an 8-byte ceiling.
  admitted = setStateValueWithinQuota(
    waited.pageId, 'incoming', 'x', { maxKeysPerPage: 50, maxPageBytes: 8 }
  );
} catch (err) {
  refused = err;
}
const blockedForMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
await holder.exited;

const exhausted = await makePage('state-quota-exhausted');
db.pragma('busy_timeout = 50');
const stubborn = await holdWriteLock({ holdMs: 500, pageId: exhausted.pageId, key: 'held', value: true });
let raised = null;
try {
  setStateValueWithinQuota(
    exhausted.pageId, 'incoming', true, { maxKeysPerPage: 50, maxPageBytes: 1024 }
  );
} catch (err) {
  raised = err;
}
await stubborn.exited;
db.pragma('busy_timeout = 5000');

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(contentDir, { recursive: true, force: true });
});

test('state quota admission waits for a competing writer and sees its committed bytes', () => {
  assert.equal(refused, null, `unexpected contention error: ${refused?.cause?.code ?? refused?.code}`);
  assert.deepEqual(admitted, { ok: false, reason: 'bytes' });
  assert.ok(blockedForMs >= holdMs * 0.5, `expected lock wait, returned after ${blockedForMs}ms`);
  assert.deepEqual(getStateValue(waited.pageId, 'incoming'), { found: false });
  assert.deepEqual(getStateValue(waited.pageId, 'held'), { found: true, value: 'held' });
});

test('exhausted state-store contention is a retryable 503 and leaves no partial write', () => {
  assert.ok(raised);
  assert.equal(raised.statusCode, 503);
  assert.equal(raised.retryAfterSeconds, 1);
  assert.match(String(raised.cause?.code), /^SQLITE_BUSY/);
  assert.deepEqual(getStateValue(exhausted.pageId, 'incoming'), { found: false });
});

// Negative controls, run separately during implementation:
// - removing `.immediate` makes the first test fail quickly with SQLITE_BUSY;
// - removing contention translation makes the second lose status/retry advice.
