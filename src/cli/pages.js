#!/usr/bin/env node

/**
 * pages agent CLI — local DB operations for logical pages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DATA_DIR, getConfig } from '../lib/config.js';
import { getLogicalPage, registerLogicalPage, searchLogicalPages, unregisterLogicalPage } from '../pages/page-store.js';
import {
  createPasswordProtectedShare,
  createShare,
  describeShare,
  getActiveShare,
  getReferencedSharePasswordKeyIds,
  listAllShares,
  listSharesForSlug,
  reencryptSharePasswordCredentials,
  revealActiveSharePassword,
  revokeAllForSlug,
  revokeShare,
} from '../sharing/share-manager.js';
import {
  createSharePasswordKeyring,
  loadSharePasswordKeyring,
  resolveSharePasswordKeyFile,
  retireSharePasswordKey,
  rotateSharePasswordKeyring,
} from '../sharing/share-password-keyring.js';
import { normalizeSlug } from '../utils/slug.js';

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function printUsage() {
  console.log(`pages agent CLI

Usage:
  node pages.js register --source <path> --uri <uri> [--title <title>] [--component <name>] [--json]
  node pages.js list [--q <query>] [--json]
  node pages.js share <uri> [--duration 24h|7d|30d|permanent] [--writable] [--password|--password-stdin] [--json]
                                                       # --writable also lets link holders upload/delete this page's photos
  node pages.js shares <uri> [--json]
  node pages.js shares --all [--json]                  # every live share on this instance
  node pages.js share-info <token-or-url> [--json]     # which document is this link, and is it still live?
  node pages.js share-password get <token-or-url> [--json]
  node pages.js share-password keyring init|rotate [--json]
  node pages.js share-password keyring retire <key-id> [--json]
  node pages.js unshare <uri> [--json]                 # revokes ALL tokens on that uri
  node pages.js unshare --token <token-id> [--json]    # revokes exactly one token
  node pages.js unregister <uri> [--json]
  node pages.js allow-root add <path> [--name <name>] [--json]
  node pages.js status [--json]

Examples:
  node pages.js register --source /abs/report.md --uri reports/q3 --title "Q3 Report"
  node pages.js share reports/q3 --duration 7d
  node pages.js share reports/q3 --duration 7d --password
  printf '%s\\n' "$SECRET" | node pages.js share reports/q3 --password-stdin
  node pages.js share-password get https://example.com/s/7d640a8d1f2e4b3c9a05e6d7c8b9a0f1
  node pages.js share renovation-checklist --duration 7d --writable
  node pages.js shares --all
  node pages.js share-info https://example.com/s/7d640a8d1f2e4b3c9a05e6d7c8b9a0f1
  node pages.js unshare --token 7d640a8d1f2e4b3c9a05e6d7c8b9a0f1
  node pages.js allow-root add /Users/howard/zylos/workspace/reports --name reports`);
}

// Flags that stand alone. Everything else consumes the next argv entry, so a
// value-less flag not listed here fails with "missing value for --x".
const BOOLEAN_FLAGS = new Set(['json', 'all', 'writable', 'password', 'password-stdin']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, _: [], json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--') && BOOLEAN_FLAGS.has(token.slice(2))) {
      args[token.slice(2)] = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) {
        throw new CliError('invalid_args', `missing value for --${key}`);
      }
      args[key] = value;
      i += 1;
      continue;
    }
    args._.push(token);
  }
  return args;
}

function output(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${humanize(result)}\n`);
}

function humanize(result) {
  if (!result.ok) return `error: ${result.error}`;
  if (result.command === 'list') {
    return result.entries.map(entry => `${entry.uri} [${entry.accessMode}] -> ${entry.sourcePath}`).join('\n') || 'no pages registered';
  }
  if (result.command === 'share') {
    return [
      `Share link created for: ${result.uri}`,
      `URL: ${result.shortUrl}`,
      `Duration: ${result.duration}`,
      `Expires: ${result.expiresAt ? new Date(Number(result.expiresAt)).toISOString() : 'never'}`,
      ...(result.protection?.type === 'password' ? [`Password (secret): ${result.protection.password}`] : []),
    ].join('\n');
  }
  if (result.command === 'shares') {
    // `shares --all` spans pages, so the uri has to be on every line or the
    // output cannot answer the question the flag exists for: which document is
    // each of these links exposing? Per-page `shares <uri>` has no uri per row.
    return result.shares.map(share => [
      share.tokenId,
      ...(result.all ? [share.uri ?? '(page no longer registered)'] : []),
      share.expiresAt ? new Date(Number(share.expiresAt)).toISOString() : 'never',
      share.protection?.type === 'password' ? 'protected' : 'unprotected',
    ].join(' ')).join('\n') || 'no active shares';
  }
  if (result.command === 'unshare') {
    // A revoked share whose page row is gone has no uri to report; say that
    // rather than printing "undefined".
    return `revoked ${result.revoked} share(s) for ${result.uri ?? result.tokenId}`;
  }
  if (result.command === 'share-info') {
    const share = result.share;
    // The deleted case is the reason this command exists, so it is stated on
    // the Document line rather than left to be inferred from a status code:
    // someone reading "Document: q3/plan" must not conclude the doc is there.
    const document = share.documentDeleted
      ? `${share.uri ?? '(unknown)'} — deleted, this link no longer opens anything`
      : (share.uri ?? '(page no longer registered)');
    return [
      `Document: ${document}`,
      `Status:   ${share.status}`,
      `Created:  ${new Date(Number(share.createdAt)).toISOString()}`,
      `Duration: ${share.duration}`,
      `Expires:  ${share.expiresAt ? new Date(Number(share.expiresAt)).toISOString() : 'never'}`,
      `Protection: ${share.protection?.type === 'password' ? 'password' : 'none'}`,
      ...(share.protection?.type === 'password'
        ? [`Retrievable: ${share.protection.retrievable === true ? 'yes' : 'no'}`]
        : []),
      ...(share.revokedAt ? [`Revoked:  ${new Date(Number(share.revokedAt)).toISOString()}`] : []),
    ].join('\n');
  }
  if (result.command === 'share-password') {
    if (result.action === 'get') return `Password (secret): ${result.password}`;
    if (result.action === 'keyring-init') return `initialized share password keyring (${result.activeKeyId})`;
    if (result.action === 'keyring-rotate') {
      return `rotated share password keyring (${result.activeKeyId}); re-encrypted ${result.reencrypted} share(s)`;
    }
    if (result.action === 'keyring-retire') return `retired share password key ${result.retiredKeyId}`;
  }
  if (result.command === 'unregister') return `unregistered ${result.uri}`;
  if (result.command === 'allow-root') return `allowed root ${result.name}: ${result.path}`;
  return JSON.stringify(result, null, 2);
}

function fail(error, json) {
  const code = error instanceof CliError || typeof error?.code === 'string' ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  output({ ok: false, code, error: message }, json);
  process.exitCode = 1;
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return process.env.HOME;
  if (value.startsWith('~/')) return path.join(process.env.HOME, value.slice(2));
  return value;
}

function requireExternalFilesEnabled(config) {
  if (config.externalFiles?.enabled !== true) {
    throw new CliError('disabled', 'external file registration is disabled');
  }
}

function normalizeUri(rawUri) {
  if (!rawUri) throw new CliError('invalid_uri', 'uri is required');
  let uri;
  try {
    uri = normalizeSlug(rawUri);
  } catch {
    throw new CliError('invalid_uri', 'uri must be a valid URL path');
  }
  if (!uri || uri.includes('\\') || uri.split('/').includes('..') || uri.split('/').includes('.')) {
    throw new CliError('invalid_uri', 'uri must be a non-empty relative pages path');
  }
  return uri;
}

function getPageUrl(uri) {
  return `/pages/p/${uri}`;
}

function getBaseUrl(config = getConfig()) {
  const configured = process.env.PAGES_BASE_URL || config.publicBaseUrl || '/pages';
  return String(configured).replace(/\/$/, '');
}

function shareSlugForUri(uri) {
  const normalized = normalizeUri(uri);
  if (getLogicalPage(normalized)) return `p/${normalized}`;
  throw new CliError('page_missing', `logical page not found: ${normalized}`);
}

function formatShare(share, config = getConfig()) {
  return {
    tokenId: share.tokenId,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
    canWriteAttachments: share.canWriteAttachments === true,
    shortUrl: `${getBaseUrl(config)}/s/${share.tokenId}`,
    protection: {
      type: share.passwordProtected === true ? 'password' : 'none',
      retrievable: share.passwordProtected === true,
    },
  };
}

function configuredSharePasswordKeyFile(config = getConfig()) {
  const keyFile = resolveSharePasswordKeyFile(config);
  if (!keyFile) throw new CliError('password_custody_unavailable', 'share password keyring path is not configured');
  return keyFile;
}

function readPasswordFromStdin() {
  if (process.stdin.isTTY) {
    throw new CliError('invalid_args', '--password-stdin requires the password on standard input');
  }
  const value = fs.readFileSync(0, 'utf8').replace(/(?:\r\n|\n|\r)$/, '');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 8 || bytes > 1024) {
    throw new CliError('invalid_password', 'password must be between 8 and 1024 bytes');
  }
  return value;
}

function readConfigFileForWrite() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new CliError('invalid_config', `cannot parse config.json: ${err.message}`);
  }
}

function writeConfigFile(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

function deriveRootName(rootPath) {
  const base = path.basename(rootPath).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return base || 'source';
}

function uniqueRootName(allowedSources, preferred) {
  let name = preferred;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(allowedSources, name)) {
    name = `${preferred}-${suffix}`;
    suffix += 1;
  }
  return name;
}

function commandStatus(args) {
  const config = getConfig();
  const allowedSources = Object.fromEntries(
    Object.entries(config.externalFiles?.allowedSources || {}).map(([name, sourceRoot]) => [name, expandHome(sourceRoot)]),
  );
  output({
    ok: true,
    command: 'status',
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
    enabled: config.externalFiles?.enabled === true,
    contentDir: expandHome(config.contentDir),
    allowedSources,
    registry: 'pages.db logical_pages',
  }, args.json);
}

function commandRegister(args) {
  const config = getConfig();
  requireExternalFilesEnabled(config);
  const uri = normalizeUri(args.uri || args.slug);
  const page = registerLogicalPage({
    uri,
    title: args.title || uri,
    sourcePath: args.source,
    component: args.component,
    accessMode: args.accessMode || args['access-mode'] || 'private',
  }, config);
  output({
    ok: true,
    command: 'register',
    uri: page.uri,
    url: getPageUrl(page.uri),
    sourcePath: page.sourcePath,
    sourceRealPath: page.sourcePath,
    sourceRootName: page.sourceRootName,
    accessMode: page.accessMode,
  }, args.json);
}

function commandList(args) {
  const config = getConfig();
  requireExternalFilesEnabled(config);
  const entries = searchLogicalPages(args.q || '')
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map(entry => ({
      slug: entry.uri,
      uri: entry.uri,
      title: entry.title,
      sourcePath: entry.sourcePath,
      sourceRealPath: entry.sourcePath,
      sourceRootName: entry.sourceRootName,
      accessMode: entry.accessMode,
      url: getPageUrl(entry.uri),
      updatedAt: entry.updatedAt,
    }));
  output({ ok: true, command: 'list', entries }, args.json);
}

async function commandShare(args) {
  if (args._.length > 1) {
    throw new CliError('invalid_args', 'share accepts one URI; use --password as a boolean or --password-stdin for a provided secret');
  }
  const uri = normalizeUri(args._[0] || args.uri || args.slug);
  const duration = args.duration || '30d';
  const config = getConfig();
  if (config.sharing?.enabled === false) {
    throw new CliError('sharing_disabled', 'sharing is disabled in config (sharing.enabled=false)');
  }
  const slug = shareSlugForUri(uri);
  if (args.password && args['password-stdin']) {
    throw new CliError('invalid_args', 'use either --password or --password-stdin, not both');
  }
  const protectedShare = args.password === true || args['password-stdin'] === true;
  const password = args['password-stdin'] === true ? readPasswordFromStdin() : undefined;
  let result;
  try {
    result = protectedShare
      ? await createPasswordProtectedShare(slug, duration, {
        canWriteAttachments: args.writable === true,
        ...(password === undefined ? {} : { password }),
      }, loadSharePasswordKeyring(configuredSharePasswordKeyFile(config)))
      : createShare(slug, duration, { canWriteAttachments: args.writable === true });
  } catch (error) {
    if (error?.code) throw new CliError(error.code, error.message);
    throw error;
  }
  output({
    ok: true,
    command: 'share',
    uri,
    slug,
    duration,
    tokenId: result.tokenId,
    expiresAt: result.expiresAt,
    canWriteAttachments: result.canWriteAttachments,
    shortUrl: `${getBaseUrl(config)}/s/${result.tokenId}`,
    protection: protectedShare
      ? { type: 'password', password: result.password }
      : { type: 'none' },
  }, args.json);
}

function commandShares(args) {
  const config = getConfig();
  // `shares --all` answers "what share links are live on this box?". Without it
  // the only way to audit is to read the SQLite file directly, which is what an
  // incident response had to resort to.
  if (args.all) {
    const shares = listAllShares().map(share => ({
      ...formatShare(share, config),
      uri: share.uri,
    }));
    output({ ok: true, command: 'shares', all: true, count: shares.length, shares }, args.json);
    return;
  }
  const uri = normalizeUri(args._[0] || args.uri || args.slug);
  const slug = shareSlugForUri(uri);
  const shares = listSharesForSlug(slug).map(share => formatShare(share, config));
  output({ ok: true, command: 'shares', uri, slug, shares }, args.json);
}

// The inverse of `share`: someone hands you a link and you need to know what
// it points at. Expired and revoked links resolve too — those are exactly the
// ones whose origin nobody remembers.
function commandShareInfo(args) {
  const input = args._[0] || args.token || args.tokenId || args.url;
  if (!input) {
    throw new CliError('invalid_args', 'share-info requires a share token or URL');
  }
  const share = describeShare(input);
  if (!share) {
    throw new CliError('share_not_found', `no share found for: ${input}`);
  }
  output({
    ok: true,
    command: 'share-info',
    share: {
      ...share,
      protection: {
        type: share.passwordProtected ? 'password' : 'none',
        retrievable: share.status === 'active' && share.passwordProtected === true,
      },
    },
  }, args.json);
}

function commandSharePassword(args) {
  const action = args._[0];
  if (action === 'get') {
    const input = args._[1] || args.token || args.tokenId || args.url;
    if (!input) throw new CliError('invalid_args', 'share-password get requires a share token or URL');
    const described = describeShare(input);
    if (!described || described.status !== 'active') throw new CliError('share_not_found', 'active share not found');
    if (!described.passwordProtected) throw new CliError('not_protected', 'share is not password protected');
    try {
      const password = revealActiveSharePassword(
        described.tokenId,
        loadSharePasswordKeyring(configuredSharePasswordKeyFile()),
      );
      if (password === null) throw new CliError('share_not_found', 'active share not found');
      output({ ok: true, command: 'share-password', action: 'get', tokenId: described.tokenId, password }, args.json);
      return;
    } catch (error) {
      if (error instanceof CliError) throw error;
      const code = error?.code === 'password_custody_unavailable'
        ? error.code
        : 'password_decryption_failed';
      throw new CliError(code, error.message);
    }
  }

  if (action !== 'keyring') {
    throw new CliError('invalid_args', 'expected: share-password get <token-or-url> or share-password keyring <action>');
  }
  const keyringAction = args._[1];
  const keyFile = configuredSharePasswordKeyFile();
  try {
    if (keyringAction === 'init') {
      const keyring = createSharePasswordKeyring(keyFile);
      output({ ok: true, command: 'share-password', action: 'keyring-init', activeKeyId: keyring.activeKeyId }, args.json);
      return;
    }
    if (keyringAction === 'rotate') {
      const keyring = rotateSharePasswordKeyring(keyFile);
      const reencrypted = reencryptSharePasswordCredentials(keyring);
      output({
        ok: true,
        command: 'share-password',
        action: 'keyring-rotate',
        activeKeyId: keyring.activeKeyId,
        reencrypted,
      }, args.json);
      return;
    }
    if (keyringAction === 'retire') {
      const keyId = args._[2];
      if (!keyId) throw new CliError('invalid_args', 'share-password keyring retire requires a key id');
      retireSharePasswordKey(keyFile, keyId, getReferencedSharePasswordKeyIds());
      output({ ok: true, command: 'share-password', action: 'keyring-retire', retiredKeyId: keyId }, args.json);
      return;
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(error?.code || 'password_custody_unavailable', error.message);
  }
  throw new CliError('invalid_args', 'expected: share-password keyring init, rotate, or retire <key-id>');
}

function commandUnshare(args) {
  // Revoking one token requires --token: `unshare <uri>` revokes EVERY token on
  // that uri, which is easy to reach for when only one link was meant to die.
  const tokenId = args.token || args.tokenId;
  if (tokenId) {
    // Resolve before revoking: afterwards the share is no longer active and the
    // uri can no longer be looked up, which is what left the output saying
    // "revoked 1 share(s) for undefined".
    const target = getActiveShare(tokenId);
    const revoked = revokeShare(tokenId);
    if (!revoked) {
      throw new CliError('share_not_found', `no active share with token ${tokenId} (unknown token, or already revoked)`);
    }
    output({ ok: true, command: 'unshare', tokenId, uri: target?.uri ?? null, revoked: 1 }, args.json);
    return;
  }
  const uri = normalizeUri(args._[0] || args.uri || args.slug);
  const slug = shareSlugForUri(uri);
  const revoked = revokeAllForSlug(slug);
  output({ ok: true, command: 'unshare', uri, slug, revoked }, args.json);
}

function commandUnregister(args) {
  const uri = normalizeUri(args._[0] || args.uri || args.slug);
  try {
    const result = unregisterLogicalPage(uri);
    output({
      ok: true,
      command: 'unregister',
      uri: result.page.uri,
      pageId: result.page.pageId,
      tombstonedShares: result.tombstonedShares,
      removedSessions: result.removedSessions,
      sourcePath: result.page.sourcePath,
    }, args.json);
  } catch (err) {
    if (err?.code === 'page_missing') {
      throw new CliError('page_missing', `logical page not found: ${uri}`);
    }
    throw err;
  }
}

function commandAllowRoot(args) {
  const subcommand = args._[0];
  if (subcommand !== 'add') {
    throw new CliError('invalid_args', 'expected: allow-root add <path> [--name <name>]');
  }
  const rawPath = args._[1];
  if (!rawPath) throw new CliError('invalid_args', 'path is required');
  const expanded = path.resolve(expandHome(rawPath));
  if (!path.isAbsolute(expanded)) {
    throw new CliError('invalid_path', 'path must resolve to an absolute path');
  }
  let realPath;
  try {
    realPath = fs.realpathSync(expanded);
  } catch {
    throw new CliError('path_missing', 'allowed root path does not exist');
  }
  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) {
    throw new CliError('invalid_path', 'allowed root path must be a directory');
  }

  const fileConfig = readConfigFileForWrite();
  fileConfig.externalFiles = fileConfig.externalFiles && typeof fileConfig.externalFiles === 'object'
    ? fileConfig.externalFiles
    : {};
  fileConfig.externalFiles.enabled = fileConfig.externalFiles.enabled ?? true;
  fileConfig.externalFiles.allowedSources = fileConfig.externalFiles.allowedSources && typeof fileConfig.externalFiles.allowedSources === 'object'
    ? fileConfig.externalFiles.allowedSources
    : {};

  const preferredName = args.name || deriveRootName(realPath);
  const existing = Object.entries(fileConfig.externalFiles.allowedSources)
    .find(([, value]) => {
      try {
        return fs.realpathSync(expandHome(value)) === realPath;
      } catch {
        return path.resolve(expandHome(value)) === realPath;
      }
    });
  const name = existing?.[0] || uniqueRootName(fileConfig.externalFiles.allowedSources, preferredName);
  fileConfig.externalFiles.allowedSources[name] = realPath;
  writeConfigFile(fileConfig);
  output({ ok: true, command: 'allow-root', name, path: realPath, configPath: CONFIG_PATH }, args.json);
}

export async function main(argv) {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'status':
      return commandStatus(args);
    case 'register':
      return commandRegister(args);
    case 'list':
      return commandList(args);
    case 'share':
      return commandShare(args);
    case 'shares':
      return commandShares(args);
    case 'share-info':
      return commandShareInfo(args);
    case 'share-password':
      return commandSharePassword(args);
    case 'unshare':
      return commandUnshare(args);
    case 'unregister':
      return commandUnregister(args);
    case 'allow-root':
      return commandAllowRoot(args);
    case undefined:
    case '--help':
    case 'help':
      return printUsage();
    default:
      throw new CliError('invalid_args', `unknown command: ${args.command}`);
  }
}

export async function run(argv) {
  try {
    await main(argv);
  } catch (err) {
    const json = argv.includes('--json');
    fail(err, json);
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await run(process.argv.slice(2));
}
