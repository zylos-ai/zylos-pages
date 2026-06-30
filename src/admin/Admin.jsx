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

function Icon({ name }) {
  const paths = {
    layers: 'M12 2 2 7l10 5 10-5-10-5Zm0 8L2 15l10 5 10-5-10-5Z',
    search: 'M11 4a7 7 0 1 0 4.9 12l4.3 4.3 1.4-1.4-4.3-4.3A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
    link: 'M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12Zm4.1 1h8v-2H8v2Zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10Z',
    copy: 'M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z',
    check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
    eye: 'M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  };
  return (
    <svg className="i" viewBox="0 0 24 24" aria-hidden="true" width="16" height="16">
      <path d={paths[name]} fill="currentColor" />
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

function CopyButton({ text }) {
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
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function ShareControl({ uri, onShare }) {
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState('7d');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function submit() {
    setBusy(true);
    try {
      const share = await onShare(uri, duration);
      setResult(share);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
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
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setResult(null); setOpen(false); }}>Done</button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
        <Icon name="link" /> Share
      </button>
    );
  }

  return (
    <div className="share-control">
      <label className="share-control-label">
        Expires
        <select value={duration} onChange={e => setDuration(e.target.value)} disabled={busy}>
          {SHARE_DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </label>
      <button type="button" className="btn btn-sm btn-primary" onClick={submit} disabled={busy}>
        {busy ? 'Creating…' : 'Create link'}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
    </div>
  );
}

function PageCard({ page, onShare }) {
  return (
    <article className="page-card">
      <div className="page-card-body">
        <div className="page-card-head">
          <a className="page-card-title" href={page.url}>{page.title || page.uri}</a>
          <span className={`badge badge-${page.accessMode === 'shared' ? 'shared' : 'private'}`}>
            {page.accessMode === 'shared' ? 'Shared' : 'Private'}
          </span>
        </div>
        <code className="page-card-uri">{page.uri}</code>
        <div className="page-card-meta">
          {page.sourceRootName ? <span className="badge badge-neutral">{page.sourceRootName}</span> : null}
          {page.updatedAt ? <span className="page-card-time">Updated {formatRelativeTime(page.updatedAt)}</span> : null}
        </div>
      </div>
      <div className="page-card-actions">
        <a className="btn btn-sm btn-secondary" href={page.url}><Icon name="eye" /> View</a>
        <ShareControl uri={page.uri} onShare={onShare} />
      </div>
    </article>
  );
}

const EMPTY_FORM = { uri: '', title: '', component: '', source_path: '' };

function AdminApp() {
  const [pages, setPages] = useState([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [registerOpen, setRegisterOpen] = useState(false);
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

  const countLabel = useMemo(() => {
    if (loading) return 'Loading…';
    const n = pages.length;
    if (searched) return `${n} match${n === 1 ? '' : 'es'} for “${searched}”`;
    return `${n} registered page${n === 1 ? '' : 's'}`;
  }, [loading, pages.length, searched]);

  async function registerPage(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const res = await api('/api/pages', { method: 'POST', body: JSON.stringify(form) });
      setForm(EMPTY_FORM);
      setRegisterOpen(false);
      setQuery('');
      await loadPages('');
      notify('success', `Registered “${res.page?.title || form.uri}”.`);
    } catch (err) {
      notify('error', err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const createShare = useCallback(async (uri, duration) => {
    try {
      const result = await api('/api/share', {
        method: 'POST',
        body: JSON.stringify({ slug: `p/${uri}`, duration }),
      });
      notify('success', 'Share link created.');
      return result;
    } catch (err) {
      notify('error', err.message);
      return null;
    }
  }, [notify]);

  function updateField(event) {
    const { name, value } = event.target;
    setForm(current => ({ ...current, [name]: value }));
  }

  function onSearch(event) {
    event.preventDefault();
    loadPages(query.trim());
  }

  function clearSearch() {
    setQuery('');
    loadPages('');
  }

  return (
    <div className="admin-shell">
      <header className="admin-heading">
        <div>
          <h1>Pages</h1>
          <p className="admin-subtitle">Registered pages and share links.</p>
        </div>
        <div className="admin-heading-actions">
          <span className="admin-count">{countLabel}</span>
          <button type="button" className="btn btn-primary" onClick={() => setRegisterOpen(true)}>
            <Icon name="plus" /> Register page
          </button>
        </div>
      </header>

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {registerOpen ? (
        <div className="admin-modal" role="dialog" aria-modal="true" aria-labelledby="register-page-title">
          <button type="button" className="admin-modal-backdrop" aria-label="Close registration" onClick={() => setRegisterOpen(false)} />
          <section className="admin-modal-panel">
            <div className="admin-modal-header">
              <div>
                <h2 id="register-page-title">Register page</h2>
                <p>Pages are private until shared.</p>
              </div>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRegisterOpen(false)}>Close</button>
            </div>
          <form className="admin-form" onSubmit={registerPage}>
            <label>
              <span className="field-label">URI <em>required</em></span>
              <input name="uri" required placeholder="recruit/q3-report" value={form.uri} onChange={updateField} />
              <span className="field-hint">The logical path visitors will use, e.g. <code>/p/recruit/q3-report</code>.</span>
            </label>
            <label>
              <span className="field-label">Title <em>required</em></span>
              <input name="title" required placeholder="Q3 Recruiting Report" value={form.title} onChange={updateField} />
              <span className="field-hint">Shown in the page list and search.</span>
            </label>
            <label>
              <span className="field-label">Component <em>optional</em></span>
              <input name="component" placeholder="recruit" value={form.component} onChange={updateField} />
              <span className="field-hint">Which component owns this page.</span>
            </label>
            <label>
              <span className="field-label">Source path <em>required</em></span>
              <input name="source_path" required placeholder="/absolute/path/to/file.md" value={form.source_path} onChange={updateField} />
              <span className="field-hint">Advanced path registration. Agent CLI is the normal registration path.</span>
            </label>
            <div className="private-default-row">
              <span className="badge badge-private">Private by default</span>
            </div>
            <div className="admin-form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Registering…' : 'Register page'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setRegisterOpen(false)} disabled={submitting}>Cancel</button>
            </div>
          </form>
          </section>
        </div>
      ) : null}

        <section className="card">
          <div className="card-header">
            <Icon name="search" />
            <h2>Pages</h2>
          </div>
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

          <div className="admin-list">
            {loading ? (
              <div className="admin-skeleton">
                <div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" />
              </div>
            ) : pages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><Icon name="layers" /></div>
                {searched ? (
                  <>
                    <p className="empty-title">No pages match “{searched}”.</p>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={clearSearch}>Clear search</button>
                  </>
                ) : (
                  <>
                    <p className="empty-title">No pages registered yet.</p>
                    <p className="empty-hint">Use “Register a page” to add your first one — it’ll appear here.</p>
                  </>
                )}
              </div>
            ) : (
              pages.map(page => <PageCard key={page.uri} page={page} onShare={createShare} />)
            )}
          </div>
        </section>
    </div>
  );
}

if (rootElement) {
  createRoot(rootElement).render(<AdminApp />);
}
