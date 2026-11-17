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

// Only prune paths the server has positively confirmed are absent.
export function pruneCollapsedFolders(remembered, missingPaths) {
  const missing = new Set(missingPaths);
  const kept = new Set([...remembered].filter(path => !missing.has(path)));
  return kept.size === remembered.size ? remembered : kept;
}

export function loadExpandedFolders(basePath, storage) {
  return loadCollapsedFolders(`expanded:${basePath}`, storage);
}

export function saveExpandedFolders(basePath, expanded, storage) {
  saveCollapsedFolders(`expanded:${basePath}`, expanded, storage);
}
