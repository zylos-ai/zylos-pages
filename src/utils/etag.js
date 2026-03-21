// Content-hash based ETag generation (P0-3)

import { createHash } from 'node:crypto';

export function generateEtag(content) {
  return '"' + createHash('sha256').update(content).digest('hex').slice(0, 32) + '"';
}
