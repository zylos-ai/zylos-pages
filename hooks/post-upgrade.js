#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-pages
 *
 * Handles config schema migrations.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const configPath = path.join(HOME, 'zylos/components/pages/config.json');

console.log('[post-upgrade] Checking config migrations...');

if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let migrated = false;

  // Migration: add security section if missing
  if (!config.security) {
    config.security = {
      allowRawHtml: false,
      maxFileSizeBytes: 1048576,
      renderTimeoutMs: 5000,
    };
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

console.log('[post-upgrade] Complete!');
