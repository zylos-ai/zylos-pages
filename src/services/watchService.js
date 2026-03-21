// File watcher for cache invalidation (P0-3)
// Uses native fs.watch (chokidar v4 doesn't fire events on this platform)

import { watch } from 'node:fs';
import { invalidatePage } from '../cache/pageCache.js';
import { normalizeSlug } from '../utils/slug.js';
import { logger } from '../utils/logger.js';

let watcher = null;
const debounceTimers = new Map();

/**
 * Convert a watcher filename to a cache key.
 */
function filenameToCacheKey(filename) {
  if (!filename || !filename.endsWith('.md')) return null;
  const withoutExt = filename.replace(/\.md$/i, '');
  return normalizeSlug(withoutExt);
}

/**
 * Start watching the content directory for .md file changes.
 * Uses native fs.watch with recursive option.
 */
export function startWatcher(contentRoot) {
  try {
    watcher = watch(contentRoot, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith('.md')) return;

      const key = filenameToCacheKey(filename);
      if (!key) return;

      // Debounce: file writes can trigger multiple events
      if (debounceTimers.has(key)) {
        clearTimeout(debounceTimers.get(key));
      }

      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        const evicted = invalidatePage(key);
        logger.info(`file ${eventType}, cache ${evicted ? 'invalidated' : 'not cached'}`, {
          file: filename, key, event: eventType,
        });
      }, 300));
    });

    logger.info('file watcher started (fs.watch)', { contentRoot });
  } catch (err) {
    logger.error('failed to start file watcher', { err: err.message, contentRoot });
  }
}

export function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    // Clear any pending debounce timers
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
    logger.info('file watcher stopped');
  }
}
