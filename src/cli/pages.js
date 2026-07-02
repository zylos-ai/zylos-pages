#!/usr/bin/env node

/**
 * pages agent CLI — local DB operations for logical pages.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DATA_DIR, getConfig } from '../lib/config.js';
import { getLogicalPage, registerLogicalPage, searchLogicalPages, unregisterLogicalPage } from '../pages/page-store.js';
import { createShare, listSharesForSlug, revokeAllForSlug } from '../sharing/share-manager.js';
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
  node pages.js share <uri> [--duration 24h|7d|30d|permanent] [--json]
  node pages.js shares <uri> [--json]
  node pages.js unshare <uri> [--json]
  node pages.js unregister <uri> [--json]
  node pages.js allow-root add <path> [--name <name>] [--json]
  node pages.js status [--json]

Examples:
  node pages.js register --source /abs/report.md --uri reports/q3 --title "Q3 Report"
  node pages.js share reports/q3 --duration 7d
  node pages.js allow-root add /Users/howard/zylos/workspace/reports --name reports`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, _: [], json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--json') {
      args.json = true;
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
    ].join('\n');
  }
  if (result.command === 'shares') {
    return result.shares.map(share => `${share.tokenId} ${share.expiresAt ? new Date(Number(share.expiresAt)).toISOString() : 'never'}`).join('\n') || 'no active shares';
  }
  if (result.command === 'unshare') return `revoked ${result.revoked} share(s) for ${result.uri}`;
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
  };
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

function commandShare(args) {
  const uri = normalizeUri(args._[0] || args.uri || args.slug);
  const duration = args.duration || '30d';
  const config = getConfig();
  if (config.sharing?.enabled === false) {
    throw new CliError('sharing_disabled', 'sharing is disabled in config (sharing.enabled=false)');
  }
  const slug = shareSlugForUri(uri);
  const result = createShare(slug, duration, config.sharing || {});
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
  }, args.json);
}

function commandShares(args) {
  const uri = normalizeUri(args._[0] || args.uri || args.slug);
  const config = getConfig();
  const slug = shareSlugForUri(uri);
  const shares = listSharesForSlug(slug).map(share => formatShare(share, config));
  output({ ok: true, command: 'shares', uri, slug, shares }, args.json);
}

function commandUnshare(args) {
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
      removedShares: result.removedShares,
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

export function main(argv) {
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

export function run(argv) {
  try {
    main(argv);
  } catch (err) {
    const json = argv.includes('--json');
    fail(err, json);
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  run(process.argv.slice(2));
}
