// URL slug normalization (P0-1)

/**
 * Normalize a URL path slug:
 * - lowercase
 * - strip .md/.html extension
 * - collapse multiple slashes
 * - trim leading/trailing slashes
 */
export function normalizeSlug(raw) {
  let slug = decodeURIComponent(raw)
    .toLowerCase()
    .replace(/\.(md|html)$/i, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    .replace(/\s+/g, '-');
  return slug;
}
