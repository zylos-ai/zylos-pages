#!/usr/bin/env node
/**
 * Pre-upgrade hook for zylos-pages
 *
 * Backs up config before upgrade.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/pages');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[pre-upgrade] Backing up config...');

if (fs.existsSync(configPath)) {
  const backupPath = path.join(DATA_DIR, 'config.json.bak');
  fs.copyFileSync(configPath, backupPath);
  console.log('  - config.json backed up');
}

console.log('[pre-upgrade] Complete!');
