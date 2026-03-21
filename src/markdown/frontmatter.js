// Frontmatter parsing (P0-2)

import matter from 'gray-matter';

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { data: {}, content: string (markdown without frontmatter) }
 */
export function parseFrontmatter(raw) {
  try {
    const { data, content } = matter(raw);
    return { data, content };
  } catch {
    // If frontmatter parsing fails, treat the whole thing as content
    return { data: {}, content: raw };
  }
}

/**
 * Infer title from the first # heading if not in frontmatter.
 */
export function inferTitle(markdownContent) {
  const match = markdownContent.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Untitled';
}
