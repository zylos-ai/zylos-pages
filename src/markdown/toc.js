// Table of contents generation

/**
 * Extract headings (h2, h3) from HTML and build a TOC structure.
 * Returns array of { level, id, text }
 */
export function extractToc(html) {
  const headingRegex = /<h([23])\s*(?:id="([^"]*)")?\s*>(.*?)<\/h[23]>/gi;
  const items = [];
  let match;

  while ((match = headingRegex.exec(html)) !== null) {
    const level = parseInt(match[1], 10);
    const text = match[3].replace(/<[^>]+>/g, '').trim();
    const id = match[2] || slugifyHeading(text);
    items.push({ level, id, text });
  }

  return items;
}

/**
 * Inject id attributes into h2/h3 tags for anchor linking.
 */
export function injectHeadingIds(html) {
  return html.replace(
    /<h([23])(\s*>)(.*?)<\/h[23]>/gi,
    (full, level, rest, content) => {
      const text = content.replace(/<[^>]+>/g, '').trim();
      const id = slugifyHeading(text);
      return `<h${level} id="${id}"${rest}${content}</h${level}>`;
    }
  );
}

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
