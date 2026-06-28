import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

function PageRow({ page, onShare }) {
  return (
    <article className="admin-row">
      <div className="admin-row-main">
        <h2>{page.title}</h2>
        <p>{page.uri}</p>
        {page.sourceRootName ? <span className="admin-tag">{page.sourceRootName}</span> : null}
      </div>
      <div className="admin-actions">
        <a href={page.url}>View</a>
        <button type="button" onClick={() => onShare(page.uri)}>Share token</button>
      </div>
    </article>
  );
}

function AdminApp() {
  const [pages, setPages] = useState([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    uri: '',
    title: '',
    component: '',
    source_path: '',
  });

  const pageCountLabel = useMemo(() => {
    if (loading) return 'Loading...';
    return query ? `${pages.length} matching pages` : `${pages.length} registered pages`;
  }, [loading, pages.length, query]);

  const loadPages = useCallback(async (nextQuery = query) => {
    setLoading(true);
    setStatus('');
    try {
      const data = await api(`/api/pages${nextQuery ? `?q=${encodeURIComponent(nextQuery)}` : ''}`);
      setPages(data.pages || []);
    } catch (err) {
      setStatus(err.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    loadPages('');
  }, [loadPages]);

  async function registerPage(event) {
    event.preventDefault();
    setStatus('');
    try {
      await api('/api/pages', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ uri: '', title: '', component: '', source_path: '' });
      setQuery('');
      await loadPages('');
      setStatus('Page registered.');
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function createShare(uri) {
    setStatus('');
    try {
      const result = await api('/api/share', {
        method: 'POST',
        body: JSON.stringify({ slug: `p/${uri}`, duration: '24h' }),
      });
      await navigator.clipboard?.writeText(result.shortUrl).catch(() => {});
      setStatus(`Share URL: ${result.shortUrl}`);
    } catch (err) {
      setStatus(err.message);
    }
  }

  function updateField(event) {
    const { name, value } = event.target;
    setForm(current => ({ ...current, [name]: value }));
  }

  async function searchPages(event) {
    event.preventDefault();
    await loadPages(query);
  }

  return (
    <>
      <div className="admin-heading">
        <h1>Pages Admin</h1>
        <p>{pageCountLabel}</p>
      </div>

      <section className="admin-section">
        <h2>Register Page</h2>
        <form className="admin-form" onSubmit={registerPage}>
          <label>
            URI
            <input name="uri" required placeholder="project/report" value={form.uri} onChange={updateField} />
          </label>
          <label>
            Title
            <input name="title" required placeholder="Report title" value={form.title} onChange={updateField} />
          </label>
          <label>
            Component
            <input name="component" placeholder="recruit" value={form.component} onChange={updateField} />
          </label>
          <label>
            Source path
            <input name="source_path" required placeholder="/absolute/path/to/file.md" value={form.source_path} onChange={updateField} />
          </label>
          <div className="admin-form-actions">
            <button type="submit">Register</button>
          </div>
        </form>
      </section>

      <section className="admin-section">
        <h2>Pages</h2>
        <form className="admin-form admin-search" onSubmit={searchPages}>
          <input name="q" placeholder="Search title" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="submit">Search</button>
        </form>
        {status ? <p className="admin-status">{status}</p> : null}
        <div className="admin-list">
          {pages.length === 0 && !loading ? <p className="empty-state">No registered pages.</p> : null}
          {pages.map(page => <PageRow key={page.uri} page={page} onShare={createShare} />)}
        </div>
      </section>
    </>
  );
}

if (rootElement) {
  createRoot(rootElement).render(<AdminApp />);
}
