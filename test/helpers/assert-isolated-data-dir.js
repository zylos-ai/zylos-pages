import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

// State-isolation tests must prove their storage boundary before importing any
// Pages module. PAGES_DATA_DIR otherwise defaults to the installed instance,
// where a test boot could migrate live user data.
export function assertIsolatedPagesDataDir(dataDir) {
  assert.ok(process.env.PAGES_DATA_DIR, 'PAGES_DATA_DIR must be explicit for state-isolation tests');
  assert.equal(canonicalPath(process.env.PAGES_DATA_DIR), canonicalPath(dataDir));
  assert.notEqual(
    canonicalPath(dataDir),
    canonicalPath(path.join(os.homedir(), 'zylos/components/pages')),
    'state-isolation tests must never use the installed Pages data directory'
  );
}
