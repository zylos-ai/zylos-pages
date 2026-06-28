import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogicalPage } from './page-store.js';
import { getMimeType, isAssetExtension } from '../utils/mime.js';
import { normalizeSlug } from '../utils/slug.js';

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

export async function resolveLogicalAsset(pageUri, rawRelativePath) {
  const page = getLogicalPage(pageUri);
  if (!page) {
    throw new AssetResolutionError(404, 'Page not found');
  }

  const decoded = decodeAssetPath(rawRelativePath);
  const [assetPathOnly] = decoded.split(/[?#]/, 1);
  const extension = path.extname(assetPathOnly).toLowerCase();
  if (!isAssetExtension(extension)) {
    throw new AssetResolutionError(404, 'Asset not found');
  }

  const sourceDir = path.dirname(page.sourcePath);
  const candidate = path.resolve(sourceDir, assetPathOnly);
  if (!isInsideRoot(candidate, sourceDir)) {
    throw new AssetResolutionError(400, 'Invalid asset path: outside page source directory');
  }

  let realPath;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    throw new AssetResolutionError(404, 'Asset not found');
  }

  if (!isInsideRoot(realPath, sourceDir)) {
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

