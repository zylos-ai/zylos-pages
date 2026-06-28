#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../lib/config.js';
import { normalizeSlug } from '../utils/slug.js';
import { registerLogicalPage, searchLogicalPages } from '../pages/page-store.js';

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
    return result.entries.map((entry) => `${entry.slug || entry.uri} -> ${entry.sourcePath}`).join('\n') || 'no external files registered';
  }
  return JSON.stringify(result, null, 2);
}

function fail(error, json) {
  const code = error instanceof CliError || typeof error?.code === 'string' ? error.code : 'internal_error';
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
    config,
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

function getUrl(slug) {
  return `/pages/${slug}`;
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
    registry: 'pages.db logical_pages',
  }, args.json);
}

function commandList(args) {
  const externalConfig = getExternalConfig();
  requireEnabled(externalConfig);
  const entries = searchLogicalPages('')
    .sort((a, b) => a.uri.localeCompare(b.uri))
    .map((entry) => ({
      slug: entry.uri,
      uri: entry.uri,
      title: entry.title,
      sourcePath: entry.sourcePath,
      sourceRealPath: entry.sourcePath,
      accessMode: entry.accessMode,
      url: getUrl(`p/${entry.uri}`),
    }));

  output({ ok: true, entries }, args.json);
}

function commandRegister(args) {
  const externalConfig = getExternalConfig();
  requireEnabled(externalConfig);
  const slug = normalizeAndValidateSlug(args.slug);
  const page = registerLogicalPage({
    uri: slug,
    title: args.title || slug,
    sourcePath: args.source,
    component: args.component,
    accessMode: args.accessMode || args['access-mode'] || 'private',
  }, externalConfig.config);

  output({
    ok: true,
    slug,
    uri: page.uri,
    url: getUrl(`p/${page.uri}`),
    sourcePath: page.sourcePath,
    sourceRealPath: page.sourcePath,
    accessMode: page.accessMode,
  }, args.json);
}

function commandUnregister(args) {
  const externalConfig = getExternalConfig();
  requireEnabled(externalConfig);
  const slug = normalizeAndValidateSlug(args.slug);
  output({ ok: false, code: 'unsupported', error: `unregister is not supported for DB-backed logical pages yet: ${slug}` }, args.json);
  process.exitCode = 1;
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
