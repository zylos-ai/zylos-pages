#!/usr/bin/env node
/**
 * zylos-pages
 *
 * Markdown-to-HTML rendering component for zylos.
 * Write .md files, get beautiful web pages.
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import express from 'express';
import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';
import { initCache } from './cache/pageCache.js';
import { startWatcher, stopWatcher } from './services/watchService.js';
import { securityHeaders } from './security/headers.js';
import { setupAuth } from './security/auth.js';
import { createRateLimiter } from './security/rateLimit.js';
import { pageRoute } from './routes/pages.js';
import { indexRoute } from './routes/index.js';
import { logger } from './utils/logger.js';

// Initialize
console.log(`[pages] Starting...`);
console.log(`[pages] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[pages] Config loaded, enabled: ${config.enabled}`);
console.log(`[pages] Content dir: ${config.contentDir}`);
console.log(`[pages] Security: rawHtml=${config.security.allowRawHtml}, maxFileSize=${config.security.maxFileSizeBytes}, timeout=${config.security.renderTimeoutMs}ms`);
console.log(`[pages] Cache: max=${config.cache.maxEntries}, ttl=${config.cache.ttlSeconds}s`);
console.log(`[pages] Auth: ${config.auth?.enabled && config.auth?.password ? 'enabled' : 'disabled'}`);

if (!config.enabled) {
  console.log(`[pages] Component disabled in config, exiting.`);
  process.exit(0);
}

let server = null;

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[pages] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[pages] Component disabled, stopping...`);
    shutdown();
  }
});

// Main component logic
async function main() {
  // Initialize cache (render service uses worker_threads — no main-thread init needed)
  initCache({
    maxEntries: config.cache.maxEntries,
    ttlSeconds: config.cache.ttlSeconds,
  });

  // Start file watcher
  startWatcher(config.contentDir);

  // Create Express app
  const app = express();

  // Security headers
  app.use(securityHeaders());

  // Rate limiting
  app.use(createRateLimiter(config.rateLimit));

  // Serve static assets (CSS/JS) — before auth so login page can load them
  const assetsDir = path.join(import.meta.dirname, '..', 'assets');
  app.use('/_assets', express.static(assetsDir, {
    maxAge: '1d',
    immutable: true,
  }));

  // Cookie-based session authentication
  setupAuth(app, config.auth || {}, '/pages');

  // Routes
  app.get('/', indexRoute(config));
  app.get('/:slug(*)', pageRoute(config));

  // Error handler
  app.use((err, req, res, _next) => {
    logger.error('unhandled error', { err: err.message, path: req.path });
    res.status(500).send('Internal Server Error');
  });

  // Start server
  const port = config.port;
  server = app.listen(port, '127.0.0.1', () => {
    console.log(`[pages] Server listening on 127.0.0.1:${port}`);
    logger.info('server started', { port, contentDir: config.contentDir });
  });
}

// Graceful shutdown
function shutdown() {
  console.log(`[pages] Shutting down...`);
  stopWatcher();
  if (server) {
    server.close(() => {
      console.log(`[pages] Server closed`);
      process.exit(0);
    });
    // Force close after 5s
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[pages] Fatal error:`, err);
  process.exit(1);
});
