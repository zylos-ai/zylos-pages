#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../lib/config.js';
import { verifyPageDataMigration } from '../migrations/page-data-verifier.js';

const json = process.argv.slice(2).includes('--json');
const dbPath = path.join(DATA_DIR, 'pages.db');

function write(result) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.status.toUpperCase()}: ${result.checks.filter(check => check.ok).length}/${result.checks.length} checks passed\n`);
  for (const failure of result.failures) process.stdout.write(`FAIL ${failure.id}\n`);
  for (const warning of result.warnings) process.stdout.write(`WARN ${warning.id}\n`);
}

function failedResult(id, details = {}) {
  const failure = { id, ...details };
  return {
    ok: false,
    status: 'failed',
    checks: [],
    failures: [failure],
    warnings: [],
    command: 'verify-migration',
    dataDir: DATA_DIR,
    dbPath,
  };
}

if (!fs.existsSync(dbPath)) {
  write(failedResult('database.missing'));
  process.exitCode = 1;
} else {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const result = verifyPageDataMigration({ db, dataDir: DATA_DIR });
    write({ ...result, command: 'verify-migration', dataDir: DATA_DIR, dbPath });
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    write(failedResult('verifier.error', { error: err.message }));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
