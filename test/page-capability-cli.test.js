import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'src/cli/pages.js');

function makeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-capability-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-capability-data-'));
  const sourceRoot = path.join(home, 'trusted-pages');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    contentDir: sourceRoot,
    externalFiles: { enabled: true, allowedSources: { trusted: sourceRoot } },
  }));
  return { home, dataDir, sourceRoot };
}

function register(fixture, uri, capabilities) {
  const source = path.join(fixture.sourceRoot, `${uri}.html`);
  fs.writeFileSync(source, '<!doctype html><title>Capability test</title>');
  return spawnSync(process.execPath, [
    cliPath, 'register', '--source', source, '--uri', uri,
    '--component', 'trusted', '--capabilities', capabilities, '--json',
  ], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fixture.home, PAGES_DATA_DIR: fixture.dataDir },
    encoding: 'utf8',
  });
}

test('register warns on read capabilities without corrupting JSON output', () => {
  const fixture = makeFixture();
  const result = register(fixture, 'read-page', 'state.read,attachment.write');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).capabilities, ['attachment.write', 'state.read']);
  assert.match(result.stderr, /warning: read-capable HTML pages/);
  assert.match(result.stderr, /WebRTC, preconnect, and DNS/);
  assert.match(result.stderr, /only to trusted pages/);
});

test('register does not warn for write-only capabilities', () => {
  const fixture = makeFixture();
  const result = register(fixture, 'write-page', 'state.write,attachment.write');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).capabilities, ['attachment.write', 'state.write']);
  assert.doesNotMatch(result.stderr, /warning: read-capable HTML pages/);
});
