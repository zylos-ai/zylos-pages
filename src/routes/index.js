// Directory index route handler

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { indexTemplate } from '../templates/indexTemplate.js';
import { logger } from '../utils/logger.js';
import { browserBaseFromRequest } from '../lib/browser-base.js';
import { buildPageTree } from '../utils/pageTree.js';
import { resolvePageDescriptor } from '../security/pathGuard.js';

/**
 * Route handler for GET / — lists all available pages.
 */
export function indexRoute(config) {
  return async (req, res) => {
    const start = performance.now();

    try {
      const pages = await scanPages(config.contentDir);

      const html = indexTemplate(buildPageTree(pages), browserBaseFromRequest(req));
      const elapsed = Math.round(performance.now() - start);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=30');

      logger.info('index served', { count: pages.length, render_ms: elapsed });
      res.send(html);
    } catch (err) {
      logger.error('index failed', { err: err.message });
      res.status(500).send('Failed to list pages');
    }
  };
}

/**
 * Recursively scan the content directory for page files.
 * Hides files starting with _ or .
 */
export async function scanPages(contentDir, subdir = '') {
  const pagesBySlug = new Map();
  const dirPath = path.join(contentDir, subdir);

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    // Skip hidden and underscore-prefixed files
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

    const relativePath = path.join(subdir, entry.name);

    if (entry.isDirectory()) {
      const subPages = await scanPages(contentDir, relativePath);
      for (const page of subPages) {
        pagesBySlug.set(page.slug, page);
      }
    } else if (/\.(md|html)$/i.test(entry.name)) {
      try {
        const filePath = path.join(contentDir, relativePath);
        const slug = relativePath.replace(/\.(md|html)$/i, '');
        const descriptor = await resolvePageDescriptor(slug, contentDir);

        // Same-slug dedup: only the selected descriptor should appear.
        if (descriptor.filePath !== filePath) continue;

        const content = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);
        let page;

        if (descriptor.type === 'html') {
          page = {
            slug,
            title: inferTitleFromHtml(content) || slug,
            description: '',
            date: stats.mtime.toISOString().split('T')[0],
            tags: [],
            type: 'html',
          };
        } else {
          const { data } = matter(content);

          // Skip drafts
          if (data.draft === true) continue;

          page = {
            slug,
            title: data.title || inferTitleFromContent(content) || slug,
            description: data.description || '',
            date: data.date instanceof Date ? data.date.toISOString().split('T')[0] : (data.date || stats.mtime.toISOString().split('T')[0]),
            tags: data.tags || [],
            type: 'markdown',
          };
        }

        pagesBySlug.set(slug, page);
      } catch {
        // Skip files that can't be read
      }
    }
  }

  const pages = [...pagesBySlug.values()];
  // Sort by date (newest first)
  pages.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return pages;
}

function inferTitleFromContent(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function inferTitleFromHtml(content) {
  const match = content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : null;
}
