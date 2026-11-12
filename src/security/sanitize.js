// HTML and frontmatter escaping (P0-2). Rendered-HTML sanitization lives in
// src/services/renderWorker.js, the single place the render path configures it.

const ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * HTML-escape a string for safe insertion into HTML attributes/content.
 */
export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

/**
 * Escape all string values in a frontmatter object for safe HTML output.
 */
export function escapeFrontmatter(data) {
  const escaped = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      escaped[key] = escapeHtml(value);
    } else if (Array.isArray(value)) {
      escaped[key] = value.map(v => typeof v === 'string' ? escapeHtml(v) : v);
    } else {
      escaped[key] = value;
    }
  }
  return escaped;
}
