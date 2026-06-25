#!/usr/bin/env node

/**
 * pages CLI — create pages from templates, manage share links.
 *
 * Usage:
 *   node pages.js templates                          List available HTML templates
 *   node pages.js create --template <name> --slug <path>   Copy template to content dir
 *   node pages.js share <slug> [--duration 24h|7d|30d]     Create a share link
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../lib/config.js';
import { createShare } from '../sharing/share-manager.js';
import { normalizeSlug } from '../utils/slug.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '../../templates/html');

function printUsage() {
  console.log(`pages CLI — create pages from templates, manage share links.

Usage:
  node pages.js templates                                   List available templates
  node pages.js create --template <name> --slug <path>      Create page from template
  node pages.js share <slug> [--duration 24h|7d|30d]        Create a share link

Examples:
  node pages.js templates
  node pages.js create --template technical-proposal --slug docs/my-report
  node pages.js share docs/my-report --duration 30d`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--template' && rest[i + 1]) { args.template = rest[++i]; continue; }
    if (token === '--slug' && rest[i + 1]) { args.slug = rest[++i]; continue; }
    if (token === '--duration' && rest[i + 1]) { args.duration = rest[++i]; continue; }
    if (!token.startsWith('--') && !args.positional) { args.positional = token; }
  }
  return args;
}

function listTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error(`Templates directory not found: ${TEMPLATES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.html'));
  if (files.length === 0) {
    console.log('No templates found.');
    return;
  }
  console.log('Available HTML templates:\n');
  for (const f of files) {
    const name = f.replace('.html', '');
    console.log(`  ${name}`);
  }
  console.log(`\nUsage: node pages.js create --template <name> --slug <path>`);
}

function createPage(args) {
  if (!args.template) {
    console.error('Error: --template is required');
    process.exit(1);
  }
  if (!args.slug) {
    console.error('Error: --slug is required');
    process.exit(1);
  }

  const templateFile = path.join(TEMPLATES_DIR, `${args.template}.html`);
  if (!fs.existsSync(templateFile)) {
    console.error(`Template not found: ${args.template}`);
    console.error(`Run "node pages.js templates" to see available templates.`);
    process.exit(1);
  }

  const config = getConfig();
  const slug = normalizeSlug(args.slug);
  const outPath = path.join(config.contentDir, `${slug}.html`);

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  if (fs.existsSync(outPath)) {
    console.error(`File already exists: ${outPath}`);
    console.error('Delete it first or use a different slug.');
    process.exit(1);
  }

  const template = fs.readFileSync(templateFile, 'utf8');
  fs.writeFileSync(outPath, template);

  console.log(`Created: ${outPath}`);
  console.log(`Template: ${args.template}`);
  console.log(`Slug: ${slug}`);
  console.log(`\nEdit the file and replace {{PLACEHOLDER}} values with your content.`);
}

function sharePage(args) {
  const slug = args.positional || args.slug;
  if (!slug) {
    console.error('Error: slug is required. Usage: node pages.js share <slug> [--duration 30d]');
    process.exit(1);
  }

  const duration = args.duration || '30d';
  const config = getConfig();
  const normalized = normalizeSlug(slug);

  const htmlPath = path.join(config.contentDir, `${normalized}.html`);
  const mdPath = path.join(config.contentDir, `${normalized}.md`);
  if (!fs.existsSync(htmlPath) && !fs.existsSync(mdPath)) {
    console.error(`Page not found: ${normalized}`);
    console.error(`Looked in: ${config.contentDir}`);
    process.exit(1);
  }

  const result = createShare(normalized, duration, config.sharing || {});

  const baseUrl = process.env.PAGES_BASE_URL || 'https://zylos01.jinglever.com/pages';
  const shareUrl = `${baseUrl}/s/${result.tokenId}`;

  console.log(`Share link created for: ${normalized}`);
  console.log(`URL: ${shareUrl}`);
  console.log(`Duration: ${duration}`);
  console.log(`Expires: ${result.expiresAt ? new Date(result.expiresAt).toISOString() : 'never'}`);
}

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case 'templates':
    listTemplates();
    break;
  case 'create':
    createPage(args);
    break;
  case 'share':
    sharePage(args);
    break;
  case undefined:
  case '--help':
  case 'help':
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    process.exit(1);
}
