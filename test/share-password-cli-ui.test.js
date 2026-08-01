import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'src/cli/pages.js');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-cli-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-pages-password-cli-data-'));
  const sourceRoot = path.join(home, 'sources');
  const contentDir = path.join(home, 'content');
  const keyFile = path.join(home, 'keys', 'share-password-keys.json');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    contentDir,
    externalFiles: { enabled: true, allowedSources: { test: sourceRoot } },
    sharing: { enabled: true, passwordKeyFile: keyFile },
  }));
  return { home, dataDir, sourceRoot };
}

function run(fx, args, { input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fx.home, PAGES_DATA_DIR: fx.dataDir },
    encoding: 'utf8',
    input,
  });
  return result;
}

function runJson(fx, args, options) {
  const result = run(fx, [...args, '--json'], options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function register(fx, uri = 'secure/report') {
  const source = path.join(fx.sourceRoot, 'report.md');
  fs.writeFileSync(source, '# Secret-safe share\n');
  return runJson(fx, ['register', '--source', source, '--uri', uri, '--component', 'test']);
}

test('CLI creates and repeatedly retrieves generated passwords without leaking through ordinary queries', () => {
  const fx = fixture();
  const initialized = runJson(fx, ['share-password', 'keyring', 'init']);
  register(fx);

  const shared = runJson(fx, ['share', 'secure/report', '--duration', '7d', '--password']);
  const secret = shared.protection.password;
  assert.match(secret, /^[0-9]{6}$/);

  const listed = runJson(fx, ['shares', 'secure/report']);
  const described = runJson(fx, ['share-info', shared.shortUrl]);
  const listedText = run(fx, ['shares', 'secure/report']);
  const describedText = run(fx, ['share-info', shared.shortUrl]);
  assert.equal(listed.shares[0].protection.type, 'password');
  assert.equal(described.share.protection.type, 'password');
  assert.equal(listedText.status, 0, listedText.stderr || listedText.stdout);
  assert.equal(describedText.status, 0, describedText.stderr || describedText.stdout);
  assert.match(listedText.stdout, /\bprotected\b/);
  assert.match(describedText.stdout, /^Protection: password$/m);
  assert.match(describedText.stdout, /^Retrievable: yes$/m);
  assert.ok(!JSON.stringify(listed).includes(secret));
  assert.ok(!JSON.stringify(described).includes(secret));
  assert.ok(!listedText.stdout.includes(secret));
  assert.ok(!describedText.stdout.includes(secret));

  const revealed = runJson(fx, ['share-password', 'get', shared.shortUrl]);
  assert.equal(revealed.password, secret);

  const rotated = runJson(fx, ['share-password', 'keyring', 'rotate']);
  assert.equal(rotated.reencrypted, 1);
  assert.notEqual(rotated.activeKeyId, initialized.activeKeyId);
  assert.equal(runJson(fx, ['share-password', 'get', shared.tokenId]).password, secret);
  assert.equal(
    runJson(fx, ['share-password', 'keyring', 'retire', initialized.activeKeyId]).retiredKeyId,
    initialized.activeKeyId,
  );
});

test('provided CLI password is accepted only through stdin and stable failures stay secret-free', () => {
  const fx = fixture();
  runJson(fx, ['share-password', 'keyring', 'init']);
  register(fx, 'secure/provided');
  const secret = 'stdin-only-secret-value';

  const shared = runJson(fx, ['share', 'secure/provided', '--password-stdin'], { input: `${secret}\n` });
  assert.equal(shared.protection.password, secret);
  assert.ok(!['share', 'secure/provided', '--password-stdin', '--json'].includes(secret));

  const unprotected = runJson(fx, ['share', 'secure/provided']);
  const failed = run(fx, ['share-password', 'get', unprotected.tokenId, '--json']);
  assert.notEqual(failed.status, 0);
  const error = JSON.parse(failed.stdout);
  assert.equal(error.code, 'not_protected');
  assert.ok(!failed.stdout.includes(secret));
  assert.ok(!failed.stderr.includes(secret));

  const argvRejected = run(fx, ['share', 'secure/provided', '--password', secret, '--json']);
  assert.notEqual(argvRejected.status, 0);
  assert.equal(JSON.parse(argvRejected.stdout).code, 'invalid_args');
});

test('provided CLI password length boundary: 4 bytes passes, 3 bytes fails', () => {
  const fx = fixture();
  runJson(fx, ['share-password', 'keyring', 'init']);
  register(fx, 'secure/boundary');

  const tooShort = run(fx, ['share', 'secure/boundary', '--password-stdin', '--json'], { input: '123\n' });
  assert.notEqual(tooShort.status, 0);
  assert.equal(JSON.parse(tooShort.stdout).code, 'invalid_password');

  const shared = runJson(fx, ['share', 'secure/boundary', '--password-stdin'], { input: '1234\n' });
  assert.equal(shared.protection.password, '1234');
});

test('owner UI sources fetch secrets explicitly and never persist them in browser storage or URLs', () => {
  const shareScript = fs.readFileSync(path.join(repoRoot, 'assets/share.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(repoRoot, 'src/admin/Admin.jsx'), 'utf8');
  const template = fs.readFileSync(path.join(repoRoot, 'src/templates/pageTemplate.js'), 'utf8');
  const style = fs.readFileSync(path.join(repoRoot, 'assets/style.css'), 'utf8');
  const combined = `${shareScript}\n${adminSource}\n${template}`;

  assert.match(shareScript, /passwordRequest\(tokenId, 'reveal'\)/);
  assert.match(adminSource, /password\/reveal/);
  assert.match(combined, /active unprotected share/);
  assert.ok(!/localStorage|sessionStorage/.test(combined));
  assert.ok(!/[?&]password=|#password=/.test(combined));
  assert.ok(!template.includes('protection.password'));
  assert.match(style, /\.share-list-items > \.share-item \{[^}]*flex-direction:\s*column;/s);
  assert.match(style, /\.share-list-items > \.share-item \.share-item-actions \{[^}]*width:\s*100%;[^}]*flex-wrap:\s*wrap;/s);
});
