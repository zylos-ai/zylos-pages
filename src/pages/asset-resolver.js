import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogicalPage } from './page-store.js';
import { resolvePageDescriptor } from '../security/pathGuard.js';
import { getMimeType, isAssetExtension } from '../utils/mime.js';
import { normalizeSlug } from '../utils/slug.js';
import {
  createShareAssetSignature,
  shareAssetExpiresAt,
} from '../sharing/share-manager.js';

export class AssetResolutionError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'AssetResolutionError';
    this.statusCode = statusCode;
  }
}

function isInsideRoot(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandHome(value) {
  if (typeof value !== 'string') return value;
  if (value === '~') return process.env.HOME;
  if (value.startsWith('~/')) return path.join(process.env.HOME, value.slice(2));
  return value;
}

async function allowedSourceRootRealPaths(config = {}) {
  const roots = new Set();
  if (config.contentDir) roots.add(config.contentDir);
  for (const root of Object.values(config.externalFiles?.allowedSources || {})) {
    if (typeof root === 'string' && root) roots.add(expandHome(root));
  }
  for (const root of Object.values(config.sourceRegistry?.allowedSources || {})) {
    if (typeof root === 'string' && root) roots.add(expandHome(root));
  }

  const realRoots = [];
  for (const root of roots) {
    try {
      realRoots.push(await fs.realpath(root));
    } catch {
      // Ignore missing configured roots; page registration validates them.
    }
  }
  return realRoots;
}

function decodeAssetPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new AssetResolutionError(400, 'Missing asset path');
  }
  if (rawPath.includes('\0')) {
    throw new AssetResolutionError(400, 'Invalid asset path');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new AssetResolutionError(400, 'Invalid asset path');
  }
  if (decoded.includes('\0') || path.isAbsolute(decoded) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) {
    throw new AssetResolutionError(400, 'Invalid asset path');
  }
  return decoded;
}

export function logicalAssetPath(baseUrl, pageUri, relativePath) {
  const cleanBase = baseUrl || '';
  return `${cleanBase}/assets/${encodeURI(normalizeSlug(pageUri))}?${new URLSearchParams({ path: relativePath }).toString()}`;
}

function signedLogicalAssetPath(baseUrl, pageUri, relativePath, { exp, sig }) {
  const cleanBase = baseUrl || '';
  return `${cleanBase}/assets/${encodeURI(normalizeSlug(pageUri))}?${new URLSearchParams({ path: relativePath, exp: String(exp), sig }).toString()}`;
}

export function rewriteRelativeAssetRefs(html, { baseUrl = '', pageUri }) {
  if (!html || !pageUri) return html;
  return html.replace(/\b(src|href)=("([^"]*)"|'([^']*)')/gi, (full, attr, quoted, doubleValue, singleValue) => {
    const value = doubleValue ?? singleValue ?? '';
    if (!value || value.startsWith('/') || value.startsWith('#') || value.startsWith('?')) return full;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return full;
    const cleanPath = value.split(/[?#]/, 1)[0];
    if (!isAssetExtension(path.extname(cleanPath).toLowerCase())) return full;
    const rewritten = logicalAssetPath(baseUrl, pageUri, value);
    return `${attr}=${quoted[0]}${rewritten}${quoted[0]}`;
  });
}

async function pageSourceForAsset(pageUri, config = {}) {
  const page = getLogicalPage(pageUri);
  if (page) return { sourcePath: page.sourcePath };
  if (!config.contentDir) {
    throw new AssetResolutionError(404, 'Page not found');
  }
  try {
    const descriptor = await resolvePageDescriptor(pageUri, config.contentDir);
    return { sourcePath: descriptor.filePath };
  } catch (err) {
    if (err.statusCode) throw new AssetResolutionError(err.statusCode, err.message);
    throw new AssetResolutionError(404, 'Page not found');
  }
}

export async function resolveLogicalAsset(pageUri, rawRelativePath, options = {}) {
  const { config = {}, allowConfiguredRoots = false } = options;
  const page = await pageSourceForAsset(pageUri, config);
  const decoded = decodeAssetPath(rawRelativePath);
  const [assetPathOnly] = decoded.split(/[?#]/, 1);
  const extension = path.extname(assetPathOnly).toLowerCase();
  if (!isAssetExtension(extension)) {
    throw new AssetResolutionError(404, 'Asset not found');
  }

  const sourceDir = path.dirname(page.sourcePath);
  const candidate = path.resolve(sourceDir, assetPathOnly);
  if (!allowConfiguredRoots && !isInsideRoot(candidate, sourceDir)) {
    throw new AssetResolutionError(400, 'Invalid asset path: outside page source directory');
  }

  let realPath;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new AssetResolutionError(404, 'Asset not found');
  }

  if (allowConfiguredRoots) {
    const roots = await allowedSourceRootRealPaths(config);
    if (!roots.some(root => isInsideRoot(realPath, root))) {
      throw new AssetResolutionError(400, 'Invalid asset path: outside allowed source roots');
    }
  } else if (!isInsideRoot(realPath, sourceDir)) {
    throw new AssetResolutionError(400, 'Invalid asset path: outside page source directory');
  }
  if (path.extname(realPath).toLowerCase() !== extension) {
    throw new AssetResolutionError(400, 'Invalid asset path: extension mismatch');
  }

  return {
    filePath: realPath,
    mimeType: getMimeType(extension),
  };
}

function isSameOriginAssetUrl(value, baseUrl) {
  const cleanBase = baseUrl || '';
  return value.startsWith(`${cleanBase}/assets/`) || (!cleanBase && value.startsWith('/assets/'));
}

function parseLogicalAssetUrl(value, baseUrl) {
  const cleanBase = baseUrl || '';
  const prefix = `${cleanBase}/assets/`;
  if (!value.startsWith(prefix)) return null;
  const afterPrefix = value.slice(prefix.length);
  const queryIndex = afterPrefix.indexOf('?');
  if (queryIndex === -1) return null;
  const uri = decodeURIComponent(afterPrefix.slice(0, queryIndex));
  const params = new URLSearchParams(afterPrefix.slice(queryIndex + 1));
  const assetPath = params.get('path');
  if (!uri || !assetPath) return null;
  return { uri, assetPath };
}

function splitUrlSuffix(value) {
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  const indexes = [hashIndex, queryIndex].filter(index => index >= 0);
  const splitAt = indexes.length ? Math.min(...indexes) : -1;
  if (splitAt === -1) return { pathPart: value, suffix: '' };
  return { pathPart: value.slice(0, splitAt), suffix: value.slice(splitAt) };
}

async function signAssetReference(value, context) {
  if (!value || value.startsWith('#') || value.startsWith('?')) return value;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
  if (value.startsWith(`${context.baseUrl || ''}/_assets/`) || value.startsWith('/_assets/')) return value;

  let uri = context.pageUri;
  let assetPath = value;
  const existing = isSameOriginAssetUrl(value, context.baseUrl) ? parseLogicalAssetUrl(value, context.baseUrl) : null;
  if (existing) {
    uri = existing.uri;
    assetPath = existing.assetPath;
  } else {
    if (value.startsWith('/')) return value;
    const { pathPart } = splitUrlSuffix(value);
    if (!isAssetExtension(path.extname(pathPart).toLowerCase())) return value;
  }

  try {
    const resolved = await resolveLogicalAsset(uri, assetPath, {
      config: context.config,
      allowConfiguredRoots: true,
    });
    const exp = shareAssetExpiresAt(context.share.expiresAt);
    const sig = createShareAssetSignature({
      uri: context.pageUri,
      realPath: resolved.filePath,
      expiresAt: exp,
      tokenId: context.share.tokenId,
    });
    return signedLogicalAssetPath(context.baseUrl, context.pageUri, assetPath, { exp, sig });
  } catch {
    return value;
  }
}

async function rewriteSrcset(value, context) {
  const candidates = value.split(',').map(part => part.trim()).filter(Boolean);
  const rewritten = [];
  for (const candidate of candidates) {
    const [url, ...descriptor] = candidate.split(/\s+/);
    rewritten.push([await signAssetReference(url, context), ...descriptor].join(' '));
  }
  return rewritten.join(', ');
}

async function replaceAsync(input, regex, replacer) {
  const pieces = [];
  let lastIndex = 0;
  for (const match of input.matchAll(regex)) {
    pieces.push(input.slice(lastIndex, match.index));
    pieces.push(await replacer(...match));
    lastIndex = match.index + match[0].length;
  }
  pieces.push(input.slice(lastIndex));
  return pieces.join('');
}

export async function rewriteSignedShareAssetRefs(html, { baseUrl = '', pageUri, config, share }) {
  if (!html || !pageUri || !share?.tokenId) return html;
  const context = { baseUrl, pageUri: normalizeSlug(pageUri), config, share };
  let output = await replaceAsync(
    html,
    /\b(src|href)=("([^"]*)"|'([^']*)')/gi,
    async (full, attr, quoted, doubleValue, singleValue) => {
      const value = doubleValue ?? singleValue ?? '';
      const rewritten = await signAssetReference(value, context);
      return `${attr}=${quoted[0]}${rewritten}${quoted[0]}`;
    }
  );
  output = await replaceAsync(
    output,
    /\bsrcset=("([^"]*)"|'([^']*)')/gi,
    async (_full, quoted, doubleValue, singleValue) => {
      const value = doubleValue ?? singleValue ?? '';
      const rewritten = await rewriteSrcset(value, context);
      return `srcset=${quoted[0]}${rewritten}${quoted[0]}`;
    }
  );
  output = await replaceAsync(
    output,
    /url\((["']?)([^"')]+)\1\)/gi,
    async (_full, quote, value) => `url(${quote}${await signAssetReference(value.trim(), context)}${quote})`
  );
  return output;
}
