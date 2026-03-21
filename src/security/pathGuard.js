// Path traversal protection (P0-1)

import { resolve, relative, extname } from 'node:path';

export class PathViolationError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'PathViolationError';
    this.statusCode = 400;
  }
}

/**
 * Resolve a slug to a safe file path within the content root.
 * Rejects traversal attempts, null bytes, double-encoding, and non-.md files.
 */
export function resolveSafePath(slug, contentRoot) {
  // Reject null bytes
  if (slug.includes('\0')) {
    throw new PathViolationError('Invalid path: null byte detected');
  }

  // Reject double-encoded traversal (e.g., %252e%252e)
  const decoded = decodeURIComponent(slug);
  if (decoded !== slug && decoded.includes('..')) {
    throw new PathViolationError('Invalid path: double-encoded traversal');
  }

  // Reject explicit .. segments
  if (slug.includes('..')) {
    throw new PathViolationError('Invalid path: directory traversal');
  }

  // Build candidate path
  const candidate = resolve(contentRoot, slug + '.md');

  // Ensure resolved path is within content root
  const rel = relative(contentRoot, candidate);
  if (rel.startsWith('..') || resolve(contentRoot, rel) !== candidate) {
    throw new PathViolationError('Invalid path: outside content root');
  }

  // Ensure extension is .md
  if (extname(candidate) !== '.md') {
    throw new PathViolationError('Invalid path: only .md files allowed');
  }

  return candidate;
}
