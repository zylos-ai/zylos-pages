import assert from 'node:assert/strict';
import test from 'node:test';
import { collapsedFoldersKey, loadCollapsedFolders, saveCollapsedFolders, pruneCollapsedFolders, loadExpandedFolders, saveExpandedFolders } from '../src/admin/collapsed-folders.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('collapse state round-trips with separate instance keys', () => {
  const storage = memoryStorage();
  saveCollapsedFolders('/one/pages', new Set(['docs', 'docs/deep']), storage);
  saveCollapsedFolders('/two/pages', new Set(['reports']), storage);
  assert.deepEqual([...loadCollapsedFolders('/one/pages', storage)], ['docs', 'docs/deep']);
  assert.deepEqual([...loadCollapsedFolders('/two/pages', storage)], ['reports']);
  assert.equal(collapsedFoldersKey('/one/pages'), 'zylos-pages:collapsedFolders:/one/pages');
});

test('invalid or unavailable storage falls back to expanded without throwing', () => {
  const storage = memoryStorage();
  for (const value of ['{', '{}', 'null', '"docs"', '["docs",42]']) {
    storage.setItem(collapsedFoldersKey(''), value);
    assert.equal(loadCollapsedFolders('', storage).size, 0);
  }
  const unavailable = {
    getItem() { throw new Error('disabled'); },
    setItem() { throw new Error('disabled'); },
  };
  assert.equal(loadCollapsedFolders('', unavailable).size, 0);
  assert.doesNotThrow(() => saveCollapsedFolders('', new Set(['docs']), unavailable));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('disabled'); } });
  try {
    assert.equal(loadCollapsedFolders('').size, 0);
    assert.doesNotThrow(() => saveCollapsedFolders('', new Set()));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('only explicitly server-confirmed missing paths are pruned', () => {
  const remembered = new Set(['docs', 'docs/deep', 'missing', 'unloaded']);
  assert.equal(pruneCollapsedFolders(remembered, []), remembered, 'partial lists and search do not prove absence');
  const kept = pruneCollapsedFolders(remembered, ['missing']);
  assert.deepEqual([...kept], ['docs', 'docs/deep', 'unloaded']);
  const storage = memoryStorage();
  saveExpandedFolders('/one', kept, storage);
  assert.deepEqual(loadExpandedFolders('/one', storage), kept);
  assert.equal(loadExpandedFolders('/two', storage).size, 0);
});
