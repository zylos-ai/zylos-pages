#!/usr/bin/env node
/**
 * Post-install hook for zylos-pages
 *
 * Called by Claude after CLI installation (zylos add --json).
 * Creates data directories, default config, and a sample page.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/pages');
const CONTENT_DIR = path.join(HOME, 'zylos/http/public/pages');

// Generate random password and hash it
const generatedPassword = crypto.randomBytes(16).toString('base64url');
const salt = crypto.randomBytes(32);
const hash = crypto.scryptSync(generatedPassword, salt, 64);
const hashedPassword = `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;

const INITIAL_CONFIG = {
  enabled: true,
  port: 3462,
  contentDir: CONTENT_DIR,
  auth: {
    enabled: true,
    password: hashedPassword,
  },
  theme: {
    colorScheme: 'auto',
    codeTheme: 'github-dark',
  },
  cache: {
    enabled: true,
    maxEntries: 200,
    ttlSeconds: 3600,
  },
  toc: {
    enabled: true,
    minHeadings: 3,
  },
  security: {
    allowRawHtml: false,
    maxFileSizeBytes: 1048576,
    renderTimeoutMs: 5000,
  },
  rateLimit: {
    windowMs: 60000,
    max: 60,
  },
  externalFiles: {
    enabled: true,
    allowedSources: {
      recruit: path.join(HOME, 'zylos/components/recruit'),
    },
  },
};

const SAMPLE_PAGE = `---
title: Welcome to Zylos Pages
description: Your first rendered page
date: ${new Date().toISOString().split('T')[0]}
---

# Welcome to Zylos Pages

This page was automatically created during installation. You can edit or delete it.

## How It Works

1. Write a \`.md\` file in \`~/zylos/http/public/pages/\`
2. Visit \`https://your-domain/pages/filename\`
3. See it rendered as a beautiful web page

## Features

- **GFM Support** — tables, task lists, strikethrough
- **Code Highlighting** — powered by shiki (VS Code quality)
- **Dark/Light Theme** — auto-detects your preference
- **Table of Contents** — auto-generated for long documents
- **Fast** — in-memory caching with file-watch invalidation

## Example Code Block

\`\`\`javascript
// Agent writes a report
const report = generateAnalysis();
fs.writeFileSync('~/zylos/http/public/pages/q1-report.md', report);
// Instantly available at /pages/q1-report
\`\`\`

## Example Table

| Feature | Status |
|---------|--------|
| Markdown rendering | ✅ |
| Code highlighting | ✅ |
| Dark mode | ✅ |
| Table of contents | ✅ |

Happy writing!
`;

console.log('[post-install] Running pages-specific setup...\n');

// 1. Create data subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
console.log('  - logs/');

// 2. Create content directory
fs.mkdirSync(CONTENT_DIR, { recursive: true });
console.log('  - content dir: ' + CONTENT_DIR);

// 3. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  console.log('  - config.json created');
  console.log(`\n  Auth enabled. Username: pages  Password: ${generatedPassword}`);
  console.log('  To disable auth, set auth.enabled = false in config.json');
} else {
  // If config exists but has no auth section, add it
  try {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    let migrated = false;
    let generatedAuth = false;
    if (!existing.auth) {
      existing.auth = { enabled: true, password: hashedPassword };
      migrated = true;
      generatedAuth = true;
    }
    if (!existing.externalFiles) {
      existing.externalFiles = {
        enabled: true,
        allowedSources: {
          recruit: path.join(HOME, 'zylos/components/recruit'),
        },
      };
      migrated = true;
    }
    if (migrated) {
      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
      console.log('\nUpdated existing config.');
      if (generatedAuth) {
        console.log(`  Auth enabled. Password: ${generatedPassword}`);
      }
    } else {
      console.log('\nConfig already exists, skipping.');
    }
  } catch {
    console.log('\nConfig already exists, skipping.');
  }
}

// 4. Create sample welcome page if content dir is empty
const existingFiles = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md'));
if (existingFiles.length === 0) {
  console.log('\nCreating sample page...');
  fs.writeFileSync(path.join(CONTENT_DIR, 'welcome.md'), SAMPLE_PAGE);
  console.log('  - welcome.md created');
} else {
  console.log('\nContent directory not empty, skipping sample page.');
}

console.log('\n[post-install] Complete!');
