// Path traversal protection (P0-1)

import { resolve, relative, extname } from 'node:path';
import { access } from 'node:fs/promises';
import { getMimeType, isAssetExtension } from '../utils/mime.js';

export class PathViolationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'PathViolationError';
    this.statusCode = 400;
  }
}

/**
 * Validate a slug before resolving it under the content root.
 */
function validateSlug(slug) {
  // Reject null bytes
  if (slug.includes('\0')) {
    throw new PathViolationError('Invalid path: null byte detected');
  }

  // Reject double-encoded traversal (e.g., %252e%252e)
  let decoded;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    throw new PathViolationError('Invalid path: malformed encoding');
  }
  if (decoded.includes('\0')) {
    throw new PathViolationError('Invalid path: null byte detected');
  }
  if (decoded !== slug) {
    let decodedTwice = decoded;
    try {
      decodedTwice = decodeURIComponent(decoded);
    } catch {
      throw new PathViolationError('Invalid path: malformed encoding');
    }
    if (decoded.includes('..') || decodedTwice.includes('..')) {
      throw new PathViolationError('Invalid path: double-encoded traversal');
    }
  }

  // Reject explicit .. segments
  if (slug.includes('..')) {
    throw new PathViolationError('Invalid path: directory traversal');
  }
}

function resolveCandidate(slug, contentRoot, extension) {
  const candidate = resolve(contentRoot, slug + extension);
  // Ensure resolved path is within content root
  const rel = relative(contentRoot, candidate);
  if (rel.startsWith('..') || resolve(contentRoot, rel) !== candidate) {
    throw new PathViolationError('Invalid path: outside content root');
  }

  if (extname(candidate) !== extension) {
    throw new PathViolationError(`Invalid path: only ${extension} files allowed`);
  }

  return candidate;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Resolve a slug to the page representation that should be served to humans.
 * HTML artifacts take priority over markdown, but only these two extensions are considered.
 */
export async function resolvePageDescriptor(slug, contentRoot) {
  validateSlug(slug);
  const htmlPath = resolveCandidate(slug, contentRoot, '.html');
  const markdownPath = resolveCandidate(slug, contentRoot, '.md');

  if (await exists(htmlPath)) {
    const descriptor = {
      type: 'html',
      filePath: htmlPath,
      slug,
    };
    if (await exists(markdownPath)) {
      descriptor.companionPath = markdownPath;
    }
    return descriptor;
  }

  if (await exists(markdownPath)) {
    return {
      type: 'markdown',
      filePath: markdownPath,
      slug,
    };
  }

  const err = new Error('Page not found');
  err.code = 'ENOENT';
  throw err;
}

/**
 * Resolve a slug to the raw markdown source path within the content root.
 * Rejects traversal attempts, null bytes, double-encoding, and non-.md files.
 */
export function resolveSafePath(slug, contentRoot) {
  validateSlug(slug);
  return resolveCandidate(slug, contentRoot, '.md');
}

/**
 * Resolve an allowlisted static asset path within the content root.
 */
export function resolveAssetPath(slug, contentRoot) {
  validateSlug(slug);

  const extension = extname(slug).toLowerCase();
  if (!isAssetExtension(extension)) {
    const err = new Error('Asset not found');
    err.code = 'ENOENT';
    throw err;
  }

  const candidate = resolve(contentRoot, slug);
  const rel = relative(contentRoot, candidate);
  if (rel.startsWith('..') || resolve(contentRoot, rel) !== candidate) {
    throw new PathViolationError('Invalid path: outside content root');
  }

  if (extname(candidate).toLowerCase() !== extension) {
    throw new PathViolationError('Invalid path: extension mismatch');
  }

  return {
    filePath: candidate,
    mimeType: getMimeType(extension),
  };
}
