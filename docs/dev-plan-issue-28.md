# Dev Plan: HTML Artifact Support (#28)

## Summary

Add HTML file serving alongside existing markdown rendering. When a slug resolves to both `.html` and `.md`, HTML takes priority. HTML pages go through the same auth/share pipeline but get a relaxed CSP to allow inline scripts for interactivity.

## Scope

**In scope:**
- Descriptor resolver (`resolvePageDescriptor`): `.html` priority → `.md` fallback
- Separate `resolveSafePath` preserved for raw API (always `.md`)
- `normalizeSlug` strips `.html` extension (alongside existing `.md` stripping)
- HTML raw serving with scoped CSP (route handler overrides CSP before send)
- Single cache key per slug with descriptor type stored in entry; mismatch triggers invalidation
- `watchService` monitors `.html` files
- `scanPages` covers `.html` + `.md` with same-slug dedup (HTML priority)
- Share token binds to canonical slug (no extension)

**Out of scope:**
- Theme/nav injection into HTML pages (agent controls layout)
- Bundled JS libraries (Phase 1: agent uses inline JS or self-hosted assets under `/_assets/`; external CDN `<script src="https://...">` blocked by `script-src 'self'` — CDN allowlist is a future explicit configuration, not default-open)
- Share viewer access to companion `.md` raw source
- Runtime source link injection (Phase 1: authoring convention only)
- markdown-it plugin enhancements

## Source Link Contract (Phase 1)

Phase 1 does NOT inject a "View source (Markdown)" link at runtime. The contract:
- Agent-authored HTML that has a companion `.md` should include the link itself (authoring convention)
- Link target: use a relative path from the current page, e.g. `api/raw/{slug}` (relative to browserBase), or the full browser-visible path `{browserBase}/api/raw/{slug}` (e.g. `/pages/api/raw/foo` when mounted under `/pages`). Absolute `/api/raw/foo` will break behind reverse-proxy prefixes — authenticated viewers only
- Share viewers cannot access raw markdown source (existing `raw-api.js` share-viewer block preserved)
- No runtime DOM injection by Pages

## Development Checklist

### 1. Slug normalization
- [ ] `normalizeSlug()` in `src/utils/slug.js`: strip `.html` in addition to `.md`
- [ ] Test: `/foo.html`, `/foo.md`, `/foo` all normalize to `foo`

### 2. Path resolver — two functions, clear ownership
- [ ] NEW: `resolvePageDescriptor(slug, contentRoot)` in `src/security/pathGuard.js`
  - Returns `{ type: 'html' | 'markdown', filePath, slug, companionPath? }`
  - Resolution order: check `slug.html` exists → check `slug.md` exists → throw ENOENT
  - All security checks for both extensions: null byte, double-encoded traversal, `..` segments, within-root validation
  - Extension allowlist: only `.html` and `.md` (fail-closed)
  - `companionPath`: if type is `html` and `.md` also exists, populate (for future source link use)
  - Used by: `pageService.getPage()`, `scanPages()`
- [ ] KEEP: `resolveSafePath(slug, contentRoot)` — unchanged, always resolves to `.md`
  - Used by: `raw-api.js` (always serves markdown source)
  - Ownership boundary: raw API never returns HTML, even when both exist

### 3. Page service branching
- [ ] `getPage()` in `src/services/pageService.js`: call `resolvePageDescriptor` instead of `resolveSafePath`
- [ ] If descriptor type is `html`: read file directly (`fs.readFile`), compute etag, return `{ html, etag, meta: {}, type: 'html', companionPath }`
- [ ] If descriptor type is `markdown`: existing `renderPage` pipeline (unchanged)
- [ ] Cache strategy: single key per slug (`base:slug`), cache entry stores `{ type, filePath, cachedAt, html, etag, meta }`
  - On cache hit: run `resolvePageDescriptor` first, compare descriptor `type` + `filePath` with cached entry
  - If mismatch (e.g. `.html` was added/removed since cache): invalidate and re-render
  - Then stat mtime validation as existing safety net
- [ ] Max file size check: apply `maxFileSizeBytes` to HTML files too

### 4. Route handler update
- [ ] `pageRoute()` in `src/routes/pages.js`: detect descriptor type from `getPage` result
- [ ] For HTML: skip share-viewer injection and nav-sidebar injection (serve as-is)
- [ ] For HTML: override CSP header before `res.send()` (Option A — route handler sets relaxed CSP directly)
- [ ] For markdown: existing flow unchanged
- [ ] Redirect `.html` extension URLs to clean URLs (like current `.md` redirect)
- [ ] Extension redirect must preserve query string (share token in `?token=...`)

### 5. Scoped CSP (Option A: route handler override)
- [ ] `securityHeaders()` in `src/security/headers.js`: unchanged (sets default strict CSP for all responses)
- [ ] `pageRoute()` overrides the `Content-Security-Policy` header for HTML artifacts before sending:
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline'`
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data: https:`
  - `connect-src 'self'`
  - `object-src 'none'`
  - `frame-ancestors 'none'`
  - `base-uri 'self'`
- [ ] Non-CSP security headers unchanged for all responses (`nosniff`, `X-Frame-Options`, `Referrer-Policy`)
- [ ] Export a `HTML_ARTIFACT_CSP` constant from `headers.js` for the route to use (single source of truth)

### 6. Watch service
- [ ] `watchService.js`: extend `filenameToCacheKey` to handle `.html` files (strip `.html` like `.md`)
- [ ] Watcher callback: trigger on both `.md` and `.html` file changes
- [ ] On change to either extension: invalidate cache for that slug
- [ ] `invalidatePagesForSlug` in `pageCache.js`: verify it correctly matches single-key scheme (`base:slug`)

### 7. Index scan
- [ ] `scanPages()` in `src/routes/index.js`: scan `.html` files in addition to `.md`
- [ ] For `.html` files: extract title from `<title>` tag if present, otherwise use slug
- [ ] Same-slug dedup: if both `.html` and `.md` exist, include only once (HTML priority)
- [ ] Mark entries with type so index template can optionally distinguish

### 8. Tests
- [ ] Unit: `normalizeSlug` strips `.html`
- [ ] Unit: `resolvePageDescriptor` returns correct type for `.html`-only, `.md`-only, both-exist, neither-exist
- [ ] Unit: `resolvePageDescriptor` rejects traversal/null-byte for `.html` paths
- [ ] Unit: `resolvePageDescriptor` populates `companionPath` when both exist
- [ ] Unit: `resolveSafePath` still only resolves `.md` (not affected by HTML priority)
- [ ] Unit: scoped CSP applied only for HTML artifact responses
- [ ] Unit: `scanPages` deduplicates same-slug `.html` + `.md`
- [ ] Integration: request `/foo` when only `foo.md` exists → markdown render
- [ ] Integration: request `/foo` when only `foo.html` exists → raw HTML with relaxed CSP
- [ ] Integration: request `/foo` when both exist → HTML served, correct CSP
- [ ] Integration: request `/foo.html` → redirect to `/foo` (preserving query string)
- [ ] Integration: auth required for HTML pages (no bypass)
- [ ] Integration: share token works for HTML pages
- [ ] Integration: `/api/raw/foo` when both exist → returns `.md` content (not HTML)
- [ ] Integration: share viewer on `/api/raw/foo` → 403 (unchanged)
- [ ] Cache: cached markdown → add `foo.html` → next `/foo` immediately serves HTML
- [ ] Cache: cached HTML → remove `foo.html` → next `/foo` falls back to `.md`
- [ ] Cache: modify HTML content → ETag/body update (mtime validation)
- [ ] Cache: `invalidatePagesForSlug` clears entries for nested slugs and browserBase variants
- [ ] Share: token created via canonical slug → valid for both `/foo` and `/foo.html` redirect

## Assumptions

- [ ] HTML files in the content directory are trusted agent-authored content, not user uploads — **guaranteed** by deployment model (only the agent writes to `contentDir`)
- [ ] HTML files are complete documents (include their own `<html>`, `<head>`, `<body>`) — **convention**, not enforced; Pages serves whatever is in the file
- [ ] Share tokens bind to canonical slugs — **guaranteed** by current implementation (`verifyShare` uses the slug from the URL path, which is already normalized)
- [ ] `fs.watch` recursive mode supports `.html` file changes on Node >=20 Linux — **supported but not sole correctness mechanism**; stat-based mtime validation + descriptor type comparison on cache hit are the authoritative correctness checks. Watch is an optimization for faster invalidation.

## Acceptance Checklist

- [ ] `npm test` passes (all existing + new tests)
- [ ] Request `/slug` with only `.md` → renders markdown (no regression)
- [ ] Request `/slug` with only `.html` → serves HTML with relaxed CSP
- [ ] Request `/slug` with both → serves HTML
- [ ] `/api/raw/slug` with both → returns `.md` content (agents always read markdown)
- [ ] Request `/slug.html` → 301 redirect to `/slug` (query string preserved)
- [ ] Auth required: unauthenticated request to HTML page → login redirect
- [ ] Share token: valid share token for slug → HTML page accessible
- [ ] CSP: HTML page response has `script-src 'self' 'unsafe-inline'`; markdown page has `script-src 'self'`
- [ ] Index page lists HTML-only pages with correct title
- [ ] Cache: add `.html` for existing `.md` slug → next request serves HTML
- [ ] Cache: remove `.html` → next request falls back to `.md`
- [ ] Cache: modify `.html` content → updated response
- [ ] No regressions in existing markdown pages, login, share, todo boards, raw API
