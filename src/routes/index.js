// Directory index route handler

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { indexTemplate } from '../templates/indexTemplate.js';
import { logger } from '../utils/logger.js';

/**
 * Route handler for GET /pages/ — lists all available pages.
 */
export function indexRoute(config) {
  return async (req, res) => {
    const start = performance.now();

    try {
      const pages = await scanPages(config.contentDir);
      const html = indexTemplate(pages, '/pages');
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
 * Recursively scan the content directory for .md files.
 * Hides files starting with _ or .
 */
export async function scanPages(contentDir, subdir = '') {
  const pages = [];
  const dirPath = path.join(contentDir, subdir);

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return pages;
  }

  for (const entry of entries) {
    // Skip hidden and underscore-prefixed files
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

    const relativePath = path.join(subdir, entry.name);

    if (entry.isDirectory()) {
      const subPages = await scanPages(contentDir, relativePath);
      pages.push(...subPages);
    } else if (entry.name.endsWith('.md')) {
      try {
        const filePath = path.join(contentDir, relativePath);
        const content = await readFile(filePath, 'utf-8');
        const { data } = matter(content);
        const stats = await stat(filePath);

        // Skip drafts
        if (data.draft === true) continue;

        const slug = relativePath.replace(/\.md$/i, '');
        pages.push({
          slug,
          title: data.title || inferTitleFromContent(content) || slug,
          description: data.description || '',
          date: data.date instanceof Date ? data.date.toISOString().split('T')[0] : (data.date || stats.mtime.toISOString().split('T')[0]),
          tags: data.tags || [],
        });
      } catch {
        // Skip files that can't be read
      }
    }
  }

  // Sort by date (newest first)
  pages.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return pages;
}

function inferTitleFromContent(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}
