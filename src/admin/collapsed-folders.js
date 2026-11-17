export function collapsedFoldersKey(basePath) {
  return `zylos-pages:collapsedFolders:${basePath}`;
}

export function loadCollapsedFolders(basePath, storage) {
  try {
    const value = JSON.parse((storage ?? globalThis.localStorage).getItem(collapsedFoldersKey(basePath)) || '[]');
    if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) return new Set();
    return new Set(value);
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolders(basePath, collapsed, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(collapsedFoldersKey(basePath), JSON.stringify([...collapsed]));
  } catch {
    // Storage can be disabled or full; the current view still works in memory.
  }
}

export function pruneCollapsedFolders(collapsed, pages, clientFolders, fullListLoaded) {
  if (!fullListLoaded) return collapsed;
  const folders = new Set();
  for (const uri of [...pages.map(page => page.uri), ...clientFolders.map(path => `${path}/`)]) {
    let index = uri.indexOf('/');
    while (index !== -1) {
      folders.add(uri.slice(0, index));
      index = uri.indexOf('/', index + 1);
    }
  }
  const kept = new Set([...collapsed].filter(path => folders.has(path)));
  return kept.size === collapsed.size ? collapsed : kept;
}
