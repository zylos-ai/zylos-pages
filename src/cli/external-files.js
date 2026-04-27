#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from '../lib/config.js';
import { resolveSafePath } from '../security/pathGuard.js';
import { normalizeSlug } from '../utils/slug.js';

const REGISTRY_PATH = path.join(DATA_DIR, 'external-files.json');
const LOCK_PATH = path.join(DATA_DIR, 'external-files.lock');
const LOCK_RETRY_MS = Number.parseInt(process.env.PAGES_EXTERNAL_FILES_LOCK_RETRY_MS || '100', 10);
const LOCK_TIMEOUT_MS = Number.parseInt(process.env.PAGES_EXTERNAL_FILES_LOCK_TIMEOUT_MS || '5000', 10);
const STALE_LOCK_MS = Number.parseInt(process.env.PAGES_EXTERNAL_FILES_STALE_LOCK_MS || '30000', 10);

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, json: false };

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new CliError('invalid_args', `unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === 'json') {
      args.json = true;
      continue;
    }

    const value = rest[i + 1];
    if (!value || value.startsWith('--')) {
      throw new CliError('invalid_args', `missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
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
  if (!result.ok) {
    return `error: ${result.error}`;
  }
  if (Array.isArray(result.entries)) {
    return result.entries.map((entry) => `${entry.slug} -> ${entry.sourcePath}`).join('\n') || 'no external files registered';
  }
  return JSON.stringify(result, null, 2);
}

function fail(error, json) {
  const code = error instanceof CliError ? error.code : 'internal_error';
  const message = error instanceof Error ? error.message : String(error);
  output({ ok: false, code, error: message }, json);
  process.exitCode = 1;
}

function expandHome(value) {
  if (typeof value !== 'string') {
    return value;
  }
  if (value === '~') {
    return process.env.HOME;
  }
  if (value.startsWith('~/')) {
    return path.join(process.env.HOME, value.slice(2));
  }
  return value;
}

function getExternalConfig() {
  const config = getConfig();
  const externalFiles = config.externalFiles || {};
  return {
    enabled: externalFiles.enabled === true,
    allowedSources: externalFiles.allowedSources || {},
    contentDir: expandHome(config.contentDir),
  };
}

function requireEnabled(externalConfig) {
  if (!externalConfig.enabled) {
    throw new CliError('disabled', 'external file registration is disabled');
  }
}

function normalizeAndValidateSlug(rawSlug) {
  if (!rawSlug) {
    throw new CliError('invalid_slug', 'slug is required');
  }

  let slug;
  try {
    slug = normalizeSlug(rawSlug);
  } catch {
    throw new CliError('invalid_slug', 'slug must be a valid URL path');
  }
  if (!slug || slug.includes('\\') || slug.split('/').includes('..') || slug.split('/').includes('.')) {
    throw new CliError('invalid_slug', 'slug must be a non-empty relative pages path');
  }

  return slug;
}

function assertMarkdown(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.md') {
    throw new CliError('source_not_markdown', 'source must be a Markdown .md file');
  }
}

function isInsideRoot(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveAllowedRoot(externalConfig, component) {
  if (!component || !externalConfig.allowedSources[component]) {
    throw new CliError('unknown_component', `component is not configured: ${component || '(missing)'}`);
  }

  try {
    return fs.realpathSync(expandHome(externalConfig.allowedSources[component]));
  } catch {
    throw new CliError('source_outside_allowed_root', `allowed source root is not accessible for component: ${component}`);
  }
}

function resolveSource(sourcePath, allowedRoot) {
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new CliError('source_missing', 'source must be an absolute path');
  }
  assertMarkdown(sourcePath);

  let sourceRealPath;
  try {
    sourceRealPath = fs.realpathSync(sourcePath);
  } catch {
    throw new CliError('source_missing', 'source file does not exist');
  }
  assertMarkdown(sourceRealPath);

  if (!isInsideRoot(sourceRealPath, allowedRoot)) {
    throw new CliError('source_outside_allowed_root', 'source is outside the configured allowed root');
  }

  return sourceRealPath;
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { version: 1, entries: {} };
  }

  try {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    if (registry.version !== 1 || !registry.entries || typeof registry.entries !== 'object') {
      throw new Error('invalid registry shape');
    }
    return registry;
  } catch (err) {
    throw new CliError('registry_corrupt', `external file registry is corrupt: ${err.message}`);
  }
}

function writeRegistryAtomic(registry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${REGISTRY_PATH}.tmp.${process.pid}.${Date.now()}`;
  const payload = `${JSON.stringify(registry, null, 2)}\n`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, REGISTRY_PATH);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function maybeRemoveStaleLock() {
  const ownerPath = path.join(LOCK_PATH, 'owner.json');
  let owner = null;
  let ownerReadable = false;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    ownerReadable = true;
  } catch {
    owner = null;
  }

  const lockStats = lstatOrNull(LOCK_PATH);
  if (!lockStats) {
    return;
  }

  const createdAt = ownerReadable ? Date.parse(owner.createdAt) : lockStats.mtimeMs;
  const isOld = Number.isFinite(createdAt) && Date.now() - createdAt > STALE_LOCK_MS;
  const ownerAlive = ownerReadable && pidIsAlive(owner.pid);
  if (isOld && !ownerAlive) {
    fs.rmSync(LOCK_PATH, { recursive: true, force: true });
  }
}

function acquireLock(command) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(LOCK_PATH);
      fs.writeFileSync(path.join(LOCK_PATH, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        command,
      }, null, 2));
      return () => fs.rmSync(LOCK_PATH, { recursive: true, force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      maybeRemoveStaleLock();
      sleep(LOCK_RETRY_MS);
    }
  }

  throw new CliError('lock_timeout', 'timed out waiting for external file registry lock');
}

function getUrl(slug) {
  return `/pages/${slug}`;
}

function symlinkIsPagesOwned(linkPath, entry) {
  if (!entry || entry.linkPath !== linkPath) {
    return false;
  }
  try {
    return fs.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

function symlinkPointsTo(linkPath, targetRealPath) {
  try {
    return fs.realpathSync(linkPath) === targetRealPath;
  } catch {
    return false;
  }
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return null;
    }
    throw err;
  }
}

function removeRegisteredSymlink(linkPath, entry) {
  const stats = lstatOrNull(linkPath);
  if (!stats) {
    return;
  }
  if (!stats.isSymbolicLink() || entry.linkPath !== linkPath) {
    throw new CliError('slug_conflict', 'registered slug path exists but is not a pages-owned symlink');
  }
  fs.unlinkSync(linkPath);
}

function existingSlugError(linkPath, entry) {
  const stats = lstatOrNull(linkPath);
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    if (entry && symlinkIsPagesOwned(linkPath, entry)) {
      return new CliError('slug_conflict', 'registered slug path points to a different source');
    }
    return new CliError('slug_conflict', 'slug path exists but is not a pages-owned symlink');
  }
  if (entry) {
    return new CliError('slug_conflict', 'registered slug path exists but is not a pages-owned symlink');
  }
  return new CliError('normal_page_exists', 'a normal pages document already exists at this slug');
}

function createSymlinkNoReplace(sourceRealPath, linkPath, entry = null) {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOTDIR') {
      throw new CliError('slug_conflict', 'slug parent path conflicts with an existing pages document');
    }
    throw err;
  }
  try {
    fs.symlinkSync(sourceRealPath, linkPath);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      if (entry && symlinkIsPagesOwned(linkPath, entry) && symlinkPointsTo(linkPath, sourceRealPath)) {
        return false;
      }
      throw existingSlugError(linkPath, entry) || err;
    }
    throw err;
  }
}

function rollbackCreatedSymlink(linkPath, sourceRealPath) {
  try {
    const stats = fs.lstatSync(linkPath);
    if (stats.isSymbolicLink() && symlinkPointsTo(linkPath, sourceRealPath)) {
      fs.unlinkSync(linkPath);
    }
  } catch {
    // Best-effort rollback; the original error is more useful to callers.
  }
}

function commandStatus(args) {
  const externalConfig = getExternalConfig();
  const allowedSources = Object.fromEntries(
    Object.entries(externalConfig.allowedSources).map(([component, sourceRoot]) => [component, expandHome(sourceRoot)]),
  );

  output({
    ok: true,
    enabled: externalConfig.enabled,
    contentDir: externalConfig.contentDir,
    allowedSources,
    registryPath: REGISTRY_PATH,
  }, args.json);
}

function commandList(args) {
  const externalConfig = getExternalConfig();
  requireEnabled(externalConfig);
  const registry = readRegistry();
  const entries = Object.values(registry.entries)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((entry) => ({
      ...entry,
      url: getUrl(entry.slug),
    }));

  output({ ok: true, entries }, args.json);
}

function commandRegister(args) {
  const externalConfig = getExternalConfig();
  requireEnabled(externalConfig);
  const slug = normalizeAndValidateSlug(args.slug);
  const component = args.component;
  const allowedRoot = resolveAllowedRoot(externalConfig, component);
  const sourceRealPath = resolveSource(args.source, allowedRoot);
  const linkPath = resolveSafePath(slug, externalConfig.contentDir);
  const now = new Date().toISOString();
  let createdLink = false;

  const release = acquireLock('register');
  try {
    const registry = readRegistry();
    const existingEntry = registry.entries[slug];

    if (existingEntry) {
      if (existingEntry.component !== component || existingEntry.sourceRealPath !== sourceRealPath) {
        throw new CliError('slug_conflict', 'slug is already registered to a different source');
      }

      if (fs.existsSync(linkPath)) {
        if (!symlinkIsPagesOwned(linkPath, existingEntry)) {
          throw new CliError('slug_conflict', 'registered slug path exists but is not a pages-owned symlink');
        }
        if (!symlinkPointsTo(linkPath, sourceRealPath)) {
          throw new CliError('slug_conflict', 'registered slug path points to a different source');
        }
      } else {
        removeRegisteredSymlink(linkPath, existingEntry);
        createdLink = createSymlinkNoReplace(sourceRealPath, linkPath, existingEntry);
      }

      existingEntry.sourcePath = args.source;
      existingEntry.sourceRealPath = sourceRealPath;
      existingEntry.linkPath = linkPath;
      existingEntry.updatedAt = now;
      writeRegistryAtomic(registry);
      return output({
        ok: true,
        slug,
        url: getUrl(slug),
        linkPath,
        sourcePath: args.source,
      }, args.json);
    }

    const existingLinkStats = lstatOrNull(linkPath);
    if (existingLinkStats) {
      throw existingSlugError(linkPath) || new CliError('normal_page_exists', 'a normal pages document already exists at this slug');
    }

    createdLink = createSymlinkNoReplace(sourceRealPath, linkPath);
    registry.entries[slug] = {
      slug,
      component,
      sourcePath: args.source,
      sourceRealPath,
      linkPath,
      createdAt: now,
      updatedAt: now,
    };
    writeRegistryAtomic(registry);

    output({
      ok: true,
      slug,
      url: getUrl(slug),
      linkPath,
      sourcePath: args.source,
    }, args.json);
  } catch (err) {
    if (createdLink) {
      rollbackCreatedSymlink(linkPath, sourceRealPath);
    }
    throw err;
  } finally {
    release();
  }
}

function commandUnregister(args) {
  const externalConfig = getExternalConfig();
  requireEnabled(externalConfig);
  const slug = normalizeAndValidateSlug(args.slug);

  const release = acquireLock('unregister');
  try {
    const registry = readRegistry();
    const entry = registry.entries[slug];
    if (entry) {
      try {
        if (fs.lstatSync(entry.linkPath).isSymbolicLink() && symlinkPointsTo(entry.linkPath, entry.sourceRealPath)) {
          fs.unlinkSync(entry.linkPath);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
      delete registry.entries[slug];
      writeRegistryAtomic(registry);
    }

    output({ ok: true, slug }, args.json);
  } finally {
    release();
  }
}

function main(argv) {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'status':
      return commandStatus(args);
    case 'register':
      return commandRegister(args);
    case 'unregister':
      return commandUnregister(args);
    case 'list':
      return commandList(args);
    default:
      throw new CliError('invalid_args', 'expected command: status, register, unregister, or list');
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    const json = process.argv.includes('--json');
    fail(err, json);
  }
}
