/**
 * Transform a flat page list into top-level pages and folder groups.
 * Folder groups are keyed by the full dirname path, not a recursive tree.
 */
export function buildPageTree(pages) {
  const topLevel = [];
  const folderMap = new Map();

  for (const page of pages) {
    const slashIndex = page.slug.lastIndexOf('/');
    if (slashIndex === -1) {
      topLevel.push(page);
      continue;
    }

    const path = page.slug.substring(0, slashIndex);
    let folder = folderMap.get(path);
    if (!folder) {
      folder = {
        path,
        label: path.split('/').join(' / '),
        pages: [],
      };
      folderMap.set(path, folder);
    }
    folder.pages.push(page);
  }

  for (const folder of folderMap.values()) {
    folder.pages.sort(comparePagesByDateDesc);
  }

  return {
    topLevel,
    folders: Array.from(folderMap.values()).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function comparePagesByDateDesc(a, b) {
  return (b.date || '').localeCompare(a.date || '');
}
