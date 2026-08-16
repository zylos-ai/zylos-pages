#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-pages
 *
 * Handles config schema migrations.
 */

import fs from 'fs';
import path from 'path';

import { ensureSharePasswordKeyring } from './ensure-share-password-keyring.js';

const HOME = process.env.HOME;
const configPath = path.join(HOME, 'zylos/components/pages/config.json');

console.log('[post-upgrade] Checking config migrations...');

if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let migrated = false;

  // auth.enabled was an escape hatch around the owner authentication wall.
  // Remove the legacy key by presence (including false) while preserving the
  // password hash and every unrelated setting verbatim at the value level.
  if (config.auth && typeof config.auth === 'object'
      && Object.prototype.hasOwnProperty.call(config.auth, 'enabled')) {
    delete config.auth.enabled;
    migrated = true;
  }

  // Migration: add security section if missing
  if (!config.security || typeof config.security !== 'object' || Array.isArray(config.security)) {
    config.security = {
      allowRawHtml: false,
      maxFileSizeBytes: 1048576,
      maxAttachmentSizeBytes: 50 * 1024 * 1024,
      renderTimeoutMs: 5000,
    };
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(config.security, 'maxAttachmentSizeBytes')) {
    config.security.maxAttachmentSizeBytes = 50 * 1024 * 1024;
    migrated = true;
  }

  // Migration: add rateLimit section if missing
  if (!config.rateLimit) {
    config.rateLimit = { windowMs: 60000, max: 60 };
    migrated = true;
  }

  // Migration: add toc section if missing
  if (!config.toc) {
    config.toc = { enabled: true, minHeadings: 3 };
    migrated = true;
  }

  // Migration: add external file registration section if missing
  if (!config.externalFiles) {
    config.externalFiles = {
      enabled: true,
      allowedSources: {
        recruit: path.join(HOME, 'zylos/components/recruit'),
      },
    };
    migrated = true;
  }

  if (migrated) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('[post-upgrade] Config migrated');
  } else {
    console.log('[post-upgrade] No migrations needed');
  }
}

// Migration: initialize share password keyring so protected shares work
// out of the box after upgrading (runs after config migrations above so it
// sees the final config state).
ensureSharePasswordKeyring({
  log: (message) => console.log(`[post-upgrade] ${message}`),
  warn: (message) => console.warn(`[post-upgrade] ${message}`),
});

console.log('[post-upgrade] Complete!');
