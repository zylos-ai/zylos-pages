// Core rendering service: markdown → HTML page (P0-2, P0-3)

import { parseFrontmatter, inferTitle } from '../markdown/frontmatter.js';
import { createParser } from '../markdown/parser.js';
import { getHighlighter } from '../markdown/highlight.js';
import { extractToc, injectHeadingIds } from '../markdown/toc.js';
import { sanitizeRenderedHtml, escapeFrontmatter } from '../security/sanitize.js';
import { generateEtag } from '../utils/etag.js';
import { readFileSafe } from '../utils/fs.js';
import { pageTemplate } from '../templates/pageTemplate.js';

let parser = null;

/**
 * Initialize the render service (call after highlighter is ready).
 */
export function initRenderService(config = {}) {
  const highlighter = getHighlighter();
  parser = createParser(highlighter, {
    codeTheme: config.codeTheme || 'github-dark',
  });
}

/**
 * Render a markdown file to a complete HTML page.
 * @param {string} filePath - absolute path to the .md file
 * @param {object} config - { allowRawHtml, maxFileSizeBytes, tocMinHeadings, baseUrl }
 * @returns {{ html: string, etag: string, meta: object }}
 */
export async function renderPage(filePath, config = {}) {
  const {
    allowRawHtml = false,
    maxFileSizeBytes = 1048576,
    tocMinHeadings = 3,
    baseUrl = '/pages',
  } = config;

  // Read file with size check
  const { content: raw, size } = await readFileSafe(filePath, maxFileSizeBytes);

  // Parse frontmatter
  const { data: rawMeta, content: markdown } = parseFrontmatter(raw);
  const meta = escapeFrontmatter(rawMeta);

  // Infer title if not in frontmatter
  if (!meta.title) {
    meta.title = inferTitle(markdown);
  }

  // Render markdown to HTML
  let bodyHtml = await parser.parse(markdown);

  // Sanitize output
  bodyHtml = sanitizeRenderedHtml(bodyHtml, allowRawHtml);

  // Inject heading IDs for anchor links
  bodyHtml = injectHeadingIds(bodyHtml);

  // Generate TOC
  const tocItems = extractToc(bodyHtml);
  const showToc = meta.toc !== false && tocItems.length >= tocMinHeadings;

  // Build complete HTML page
  const html = pageTemplate({
    title: meta.title,
    description: meta.description || '',
    date: meta.date || '',
    tags: meta.tags || [],
    bodyHtml,
    tocItems: showToc ? tocItems : [],
    baseUrl,
  });

  const etag = generateEtag(html);

  return { html, etag, meta, size };
}
