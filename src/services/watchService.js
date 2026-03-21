// File watcher for cache invalidation (P0-3)

import { watch } from 'chokidar';
import { relative } from 'node:path';
import { invalidatePage } from '../cache/pageCache.js';
import { logger } from '../utils/logger.js';

let watcher = null;

/**
 * Start watching the content directory for .md file changes.
 * Invalidates cache entries when files are modified or deleted.
 */
export function startWatcher(contentRoot) {
  watcher = watch('**/*.md', {
    cwd: contentRoot,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('change', (filePath) => {
    const key = filePath.replace(/\.md$/i, '');
    invalidatePage(key);
    logger.info('file changed, cache invalidated', { file: filePath, key });
  });

  watcher.on('unlink', (filePath) => {
    const key = filePath.replace(/\.md$/i, '');
    invalidatePage(key);
    logger.info('file deleted, cache invalidated', { file: filePath, key });
  });

  watcher.on('error', (err) => {
    logger.error('watcher error', { err: err.message });
  });

  logger.info('file watcher started', { contentRoot });
  return watcher;
}

export function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    logger.info('file watcher stopped');
  }
}
