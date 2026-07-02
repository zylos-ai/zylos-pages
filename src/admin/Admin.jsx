import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('pages-admin-root');
const baseUrl = rootElement?.dataset.baseUrl || '';

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

const SHARE_DURATIONS = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'permanent', label: 'Permanent' },
];

function formatRelativeTime(epochMs) {
  if (!epochMs) return '';
  const diff = Date.now() - Number(epochMs);
  if (Number.isNaN(diff)) return '';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} mo ago`;
  return `${Math.round(mon / 12)} yr ago`;
}

function lastSegment(uri) {
  const index = uri.lastIndexOf('/');
  return index === -1 ? uri : uri.slice(index + 1);
}

function parentPath(uri) {
  const index = uri.lastIndexOf('/');
  return index === -1 ? '' : uri.slice(0, index);
}

function normalizeFolderPath(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .map(part => part.trim().replace(/\s+/g, '-'))
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
}

// Lucide-style stroke icons — single set, currentColor, uniform stroke.
const ICON_PATHS = {
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  folderPlus: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M12 11v4M10 13h4" /></>,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v5h5" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  pencil: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  layers: <><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" /><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" /><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" /></>,
};

function Icon({ name }) {
  return (
    <svg className="i" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(onDismiss, toast.kind === 'error' ? 7000 : 4000);
    return () => clearTimeout(id);
  }, [toast, onDismiss]);
  if (!toast) return null;
  return (
    <div className={`admin-toast admin-toast-${toast.kind}`} role="status">
      <span>{toast.message}</span>
      <button type="button" className="admin-toast-close" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

function encodeSlugPath(slug) {
  return String(slug || '')
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button type="button" className={`btn btn-sm btn-ghost copy-btn ${copied ? 'is-copied' : ''}`} onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} />
      {copied ? 'Copied' : label}
    </button>
  );
}

function ActiveSharesList({ shares, loading }) {
  return (
    <div className="share-list">
      <h4>Active shares</h4>
      {loading ? (
        <div className="share-empty">Loading shares...</div>
      ) : shares.length === 0 ? (
        <div className="share-empty">No active shares.</div>
      ) : (
        shares.map(share => (
          <div className="share-item" key={share.tokenId}>
            <div className="share-item-info">
              <a href={share.shortUrl} target="_blank" rel="noreferrer">{share.shortUrl}</a>
              <span>{share.expiresAt ? `Expires ${new Date(Number(share.expiresAt)).toLocaleString()}` : 'Never expires'}</span>
            </div>
            <div className="share-item-actions">
              <CopyButton text={share.shortUrl} label="Copy link" />
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ShareDialog({ page, onClose, notify }) {
  const [duration, setDuration] = useState('7d');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [activeShares, setActiveShares] = useState([]);
  const [loadingShares, setLoadingShares] = useState(true);

  const loadActiveShares = useCallback(async () => {
    setLoadingShares(true);
    try {
      const data = await api(`/api/shares/${encodeSlugPath(`p/${page.uri}`)}`);
      setActiveShares(data.shares || []);
    } catch (err) {
      notify('error', err.message);
    } finally {
      setLoadingShares(false);
    }
  }, [notify, page.uri]);

  useEffect(() => { loadActiveShares(); }, [loadActiveShares]);

  async function createLink() {
    setBusy(true);
    try {
      const share = await api('/api/share', {
        method: 'POST',
        body: JSON.stringify({ slug: `p/${page.uri}`, duration }),
      });
      setResult(share);
      notify('success', 'Share link created.');
      await loadActiveShares();
    } catch (err) {
      notify('error', err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
      <button type="button" className="admin-modal-backdrop" aria-label="Close share dialog" onClick={onClose} />
      <section className="admin-modal-panel">
        <div className="admin-modal-header">
          <div>
            <h2 id="share-dialog-title">Share “{page.title || page.uri}”</h2>
            <p><code>{page.uri}</code></p>
          </div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
        {result ? (
          <div className="share-result">
            <div className="share-result-url">
              <Icon name="link" />
              <a href={result.shortUrl} target="_blank" rel="noreferrer">{result.shortUrl}</a>
            </div>
            <div className="share-result-actions">
              <CopyButton text={result.shortUrl} />
              <span className="share-result-meta">
                {result.expiresAt ? `Expires ${new Date(Number(result.expiresAt)).toLocaleString()}` : 'Never expires'}
              </span>
            </div>
          </div>
        ) : (
          <div className="share-control">
            <label className="share-control-label">
              Expires
              <select value={duration} onChange={e => setDuration(e.target.value)} disabled={busy}>
                {SHARE_DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-sm btn-primary" onClick={createLink} disabled={busy}>
              {busy ? 'Creating…' : 'Create link'}
            </button>
          </div>
        )}
        <ActiveSharesList shares={activeShares} loading={loadingShares} />
      </section>
    </div>
  );
}

// The tree is derived purely from uri path prefixes. Folders have no backing
// entity: client-created folders live only in memory until a doc lands in them.
function buildTree(pages, clientFolders) {
  const root = { path: '', name: '', folders: new Map(), docs: [] };
  function ensureFolder(folderPath) {
    let node = root;
    if (!folderPath) return node;
    let current = '';
    for (const segment of folderPath.split('/')) {
      current = current ? `${current}/${segment}` : segment;
      if (!node.folders.has(segment)) {
        node.folders.set(segment, { path: current, name: segment, folders: new Map(), docs: [] });
      }
      node = node.folders.get(segment);
    }
    return node;
  }
  for (const folderPath of clientFolders) ensureFolder(folderPath);
  for (const page of pages) ensureFolder(parentPath(page.uri)).docs.push(page);

  function finalize(node) {
    const folders = Array.from(node.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(finalize);
    const docs = node.docs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { path: node.path, name: node.name, folders, docs };
  }
  return finalize(root);
}

function countDocs(node) {
  return node.docs.length + node.folders.reduce((total, folder) => total + countDocs(folder), 0);
}

function RenameInput({ page, onCommit, onCancel }) {
  const [draft, setDraft] = useState(page.title || '');
  const committed = useRef(false);
  function commit() {
    if (committed.current) return;
    committed.current = true;
    const next = draft.trim();
    if (!next || next === page.title) {
      onCancel();
      return;
    }
    onCommit(next);
  }
  return (
    <input
      className="tree-rename-input"
      value={draft}
      autoFocus
      aria-label="Rename document"
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          committed.current = true;
          onCancel();
        }
      }}
    />
  );
}

function DocRow({ page, renaming, setRenaming, onRename, onShare, showFullUri = false, draggable = true }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`tree-row tree-doc${dragging ? ' is-dragging' : ''}`}
      draggable={draggable && !renaming}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', page.pageId);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      <span className="tree-row-icon"><Icon name="file" /></span>
      <div className="tree-doc-main">
        {renaming ? (
          <RenameInput
            page={page}
            onCommit={title => onRename(page, title)}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <a className="tree-title" href={page.url}>{page.title || page.uri}</a>
        )}
        <code className="tree-uri">{showFullUri ? page.uri : lastSegment(page.uri)}</code>
      </div>
      <span className={`badge badge-${page.accessMode === 'shared' ? 'shared' : 'private'}`}>
        {page.accessMode === 'shared' ? 'Shared' : 'Private'}
      </span>
      <div className="tree-meta">
        {page.updatedAt ? <span className="tree-time">{formatRelativeTime(page.updatedAt)}</span> : null}
      </div>
      <div className="tree-actions">
        <a className="icon-btn" href={page.url} title="View" aria-label={`View ${page.title || page.uri}`}><Icon name="eye" /></a>
        <button type="button" className="icon-btn" title="Rename" aria-label={`Rename ${page.title || page.uri}`} onClick={() => setRenaming(page.pageId)}><Icon name="pencil" /></button>
        <button type="button" className="icon-btn" title="Share" aria-label={`Share ${page.title || page.uri}`} onClick={() => onShare(page)}><Icon name="link" /></button>
      </div>
    </div>
  );
}

function FolderNode({ node, collapsed, onToggle, onDropDoc, renaming, setRenaming, onRename, onShare }) {
  const [dragOver, setDragOver] = useState(false);
  const isOpen = !collapsed.has(node.path);
  const total = countDocs(node);
  return (
    <div className="tree-group">
      <div
        className={`tree-row tree-folder${dragOver ? ' is-drop-target' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        onClick={() => onToggle(node.path)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(node.path); } }}
        onDragOver={e => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          onDropDoc(e.dataTransfer.getData('text/plain'), node.path);
        }}
      >
        <span className={`tree-caret${isOpen ? ' is-open' : ''}`}><Icon name="chevron" /></span>
        <span className="tree-row-icon"><Icon name="folder" /></span>
        <span className="tree-name">{node.name}</span>
        <span className="tree-count">{total}</span>
      </div>
      {isOpen ? (
        <div className="tree-children">
          {node.folders.map(folder => (
            <FolderNode
              key={folder.path}
              node={folder}
              collapsed={collapsed}
              onToggle={onToggle}
              onDropDoc={onDropDoc}
              renaming={renaming}
              setRenaming={setRenaming}
              onRename={onRename}
              onShare={onShare}
            />
          ))}
          {node.docs.map(page => (
            <DocRow
              key={page.pageId}
              page={page}
              renaming={renaming === page.pageId}
              setRenaming={setRenaming}
              onRename={onRename}
              onShare={onShare}
            />
          ))}
          {node.folders.length === 0 && node.docs.length === 0 ? (
            <div className="tree-empty-folder">Empty folder — drop a document here to keep it.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AdminApp() {
  const [pages, setPages] = useState([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [clientFolders, setClientFolders] = useState([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [sharePage, setSharePage] = useState(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const toastSeq = useRef(0);

  const notify = useCallback((kind, message) => {
    toastSeq.current += 1;
    setToast({ kind, message, id: toastSeq.current });
  }, []);

  const loadPages = useCallback(async (nextQuery = '') => {
    setLoading(true);
    try {
      const data = await api(`/api/pages${nextQuery ? `?q=${encodeURIComponent(nextQuery)}` : ''}`);
      setPages(data.pages || []);
      setSearched(nextQuery);
    } catch (err) {
      notify('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { loadPages(''); }, [loadPages]);

  const tree = useMemo(() => buildTree(pages, clientFolders), [pages, clientFolders]);

  const countLabel = useMemo(() => {
    if (loading) return 'Loading…';
    const n = pages.length;
    if (searched) return `${n} match${n === 1 ? '' : 'es'} for “${searched}”`;
    return `${n} document${n === 1 ? '' : 's'}`;
  }, [loading, pages.length, searched]);

  const moveDoc = useCallback(async (pageId, folderPath) => {
    const page = pages.find(entry => entry.pageId === pageId);
    if (!page) return;
    if (parentPath(page.uri) === folderPath) return;
    const nextUri = folderPath ? `${folderPath}/${lastSegment(page.uri)}` : lastSegment(page.uri);
    try {
      await api(`/api/pages/${encodeURIComponent(pageId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ uri: nextUri }),
      });
      setClientFolders(current => current.filter(entry => entry !== folderPath));
      await loadPages(searched);
      notify('success', `Moved “${page.title || page.uri}” to ${folderPath || 'top level'}.`);
    } catch (err) {
      notify('error', err.message);
    }
  }, [loadPages, notify, pages, searched]);

  const renameDoc = useCallback(async (page, title) => {
    setRenaming(null);
    try {
      await api(`/api/pages/${encodeURIComponent(page.pageId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
      await loadPages(searched);
      notify('success', `Renamed to “${title}”.`);
    } catch (err) {
      notify('error', err.message);
    }
  }, [loadPages, notify, searched]);

  const toggleFolder = useCallback((folderPath) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  function createFolder(event) {
    event.preventDefault();
    const folderPath = normalizeFolderPath(newFolderName);
    if (!folderPath) {
      notify('error', 'Folder name must contain letters or digits.');
      return;
    }
    setClientFolders(current => (current.includes(folderPath) ? current : [...current, folderPath]));
    setNewFolderName('');
    setNewFolderOpen(false);
    notify('success', `Folder “${folderPath}” ready — drop a document in to keep it.`);
  }

  function onSearch(event) {
    event.preventDefault();
    loadPages(query.trim());
  }

  function clearSearch() {
    setQuery('');
    loadPages('');
  }

  const treeIsEmpty = tree.folders.length === 0 && tree.docs.length === 0;

  return (
    <div className="admin-shell">
      <header className="admin-heading">
        <div>
          <h1>Pages</h1>
          <p className="admin-subtitle">Documents, folders, and share links.</p>
        </div>
        <div className="admin-heading-actions">
          <span className="admin-count">{countLabel}</span>
          <button type="button" className="btn btn-secondary" onClick={() => setNewFolderOpen(open => !open)}>
            <Icon name="folderPlus" /> New folder
          </button>
        </div>
      </header>

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {sharePage ? (
        <ShareDialog page={sharePage} onClose={() => setSharePage(null)} notify={notify} />
      ) : null}

      <section className="card">
        <form className="admin-search" onSubmit={onSearch}>
          <div className="search-input">
            <Icon name="search" />
            <input
              name="q"
              placeholder="Search by title…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search pages by title"
            />
            {query ? (
              <button type="button" className="search-clear" aria-label="Clear search" onClick={clearSearch}>×</button>
            ) : null}
          </div>
          <button type="submit" className="btn btn-secondary">Search</button>
        </form>

        {newFolderOpen ? (
          <form className="tree-new-folder" onSubmit={createFolder}>
            <span className="tree-row-icon"><Icon name="folder" /></span>
            <input
              autoFocus
              placeholder="folder or nested/folder"
              value={newFolderName}
              aria-label="New folder name"
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setNewFolderOpen(false); }}
            />
            <button type="submit" className="btn btn-sm btn-primary">Create</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNewFolderOpen(false)}>Cancel</button>
          </form>
        ) : null}

        {loading ? (
          <div className="admin-skeleton">
            <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
          </div>
        ) : searched ? (
          pages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><Icon name="layers" /></div>
              <p className="empty-title">No pages match “{searched}”.</p>
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearSearch}>Clear search</button>
            </div>
          ) : (
            <div className="doc-tree">
              {pages.map(page => (
                <DocRow
                  key={page.pageId}
                  page={page}
                  renaming={renaming === page.pageId}
                  setRenaming={setRenaming}
                  onRename={renameDoc}
                  onShare={setSharePage}
                  showFullUri
                  draggable={false}
                />
              ))}
            </div>
          )
        ) : treeIsEmpty ? (
          <div className="empty-state">
            <div className="empty-icon"><Icon name="layers" /></div>
            <p className="empty-title">No pages registered yet.</p>
            <p className="empty-hint">Register pages with the agent CLI — they’ll appear here.</p>
          </div>
        ) : (
          <div
            className={`doc-tree${rootDragOver ? ' is-drop-target' : ''}`}
            onDragOver={e => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setRootDragOver(true);
            }}
            onDragLeave={e => {
              if (e.target === e.currentTarget) setRootDragOver(false);
            }}
            onDrop={e => {
              e.preventDefault();
              setRootDragOver(false);
              moveDoc(e.dataTransfer.getData('text/plain'), '');
            }}
          >
            {tree.folders.map(folder => (
              <FolderNode
                key={folder.path}
                node={folder}
                collapsed={collapsed}
                onToggle={toggleFolder}
                onDropDoc={moveDoc}
                renaming={renaming}
                setRenaming={setRenaming}
                onRename={renameDoc}
                onShare={setSharePage}
              />
            ))}
            {tree.docs.map(page => (
              <DocRow
                key={page.pageId}
                page={page}
                renaming={renaming === page.pageId}
                setRenaming={setRenaming}
                onRename={renameDoc}
                onShare={setSharePage}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

if (rootElement) {
  createRoot(rootElement).render(<AdminApp />);
}
