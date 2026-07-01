/**
 * List registered logical pages for navigation.
 *
 * The content directory may contain drafts, source artifacts, or historical
 * bare files, but owner-facing navigation should reflect the logical page
 * registry, not the filesystem.
 */
export async function scanPages() {
  const { listLogicalPagesForNavigation } = await import('./page-store.js');
  return listLogicalPagesForNavigation();
}
