// Safe file reading with size limit (P0-4)

import { readFile, stat } from 'node:fs/promises';

export class FileTooLargeError extends Error {
  constructor(path, size, limit) {
    super(`File ${path} is ${size} bytes, exceeds limit of ${limit} bytes`);
    this.name = 'FileTooLargeError';
    this.statusCode = 413;
  }
}

export async function readFileSafe(filePath, maxBytes) {
  const stats = await stat(filePath);
  if (stats.size > maxBytes) {
    throw new FileTooLargeError(filePath, stats.size, maxBytes);
  }
  const content = await readFile(filePath, 'utf-8');
  return { content, mtime: stats.mtimeMs, size: stats.size };
}
