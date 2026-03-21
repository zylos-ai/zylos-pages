// Shiki highlighter initialization with caching

import { createHighlighter } from 'shiki';
import { logger } from '../utils/logger.js';

let highlighter = null;

/**
 * Initialize the shiki highlighter (called once at startup).
 * Loads common languages to reduce per-request overhead.
 */
export async function initHighlighter(theme = 'github-dark') {
  const start = performance.now();
  highlighter = await createHighlighter({
    themes: [theme, 'github-light'],
    langs: [
      'javascript', 'typescript', 'python', 'rust', 'go', 'java',
      'json', 'yaml', 'toml', 'html', 'css', 'sql', 'bash', 'shell',
      'markdown', 'c', 'cpp', 'ruby', 'php', 'swift', 'kotlin',
      'dockerfile', 'graphql', 'text',
    ],
  });
  const elapsed = Math.round(performance.now() - start);
  logger.info('shiki highlighter initialized', { elapsed_ms: elapsed, theme });
  return highlighter;
}

export function getHighlighter() {
  return highlighter;
}
