// LRU page cache with TTL (P0-3)

import { LRUCache } from 'lru-cache';
import { logger } from '../utils/logger.js';

let cache;

/**
 * Initialize the page cache.
 * @param {object} options - { maxEntries, ttlSeconds }
 */
export function initCache(options = {}) {
  const { maxEntries = 200, ttlSeconds = 3600 } = options;

  cache = new LRUCache({
    max: maxEntries,
    ttl: ttlSeconds * 1000,
  });

  logger.info('page cache initialized', { maxEntries, ttlSeconds });
  return cache;
}

export function getCache() {
  return cache;
}

/**
 * Get a cached page by its normalized path key.
 * Returns { html, etag, meta } or undefined.
 */
export function getCachedPage(key) {
  return cache?.get(key);
}

/**
 * Store a rendered page in cache.
 */
export function setCachedPage(key, value) {
  cache?.set(key, value);
}

/**
 * Invalidate a specific page from cache.
 */
export function invalidatePage(key) {
  if (cache?.has(key)) {
    cache.delete(key);
    logger.info('cache invalidated', { key });
    return true;
  }
  return false;
}

/**
 * Invalidate every browser-base variant for a normalized page slug.
 */
export function invalidatePagesForSlug(slug) {
  if (!cache) return false;
  let evicted = false;
  const suffix = `:${slug}`;
  for (const key of cache.keys()) {
    if (key === slug || key.endsWith(suffix)) {
      cache.delete(key);
      evicted = true;
      logger.info('cache invalidated', { key, slug });
    }
  }
  return evicted;
}

/**
 * Get cache stats for observability.
 */
export function getCacheStats() {
  if (!cache) return { size: 0, max: 0 };
  return {
    size: cache.size,
    max: cache.max,
  };
}
