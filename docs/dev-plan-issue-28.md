# Dev Plan: HTML Artifact Support (#28)

## Summary

Add HTML file serving alongside existing markdown rendering. When a slug resolves to both `.html` and `.md`, HTML takes priority. HTML pages go through the same auth/share pipeline but get a relaxed CSP to allow inline scripts for interactivity.

## Scope

**In scope:**
- Descriptor resolver: `.html` priority → `.md` fallback
- `normalizeSlug` strips `.html` extension (alongside existing `.md` stripping)
- HTML raw serving with scoped CSP (inline scripts/styles allowed)
- Cache key includes descriptor type; cache invalidated on type change
- `watchService` monitors `.html` files
- `scanPages` covers `.html` + `.md` with same-slug dedup (HTML priority)
- Share token binds to canonical slug (no extension)

**Out of scope:**
- Theme/nav injection into HTML pages (agent controls layout)
- Bundled JS libraries (agent brings own via CDN or inline)
- Share viewer access to companion `.md` raw source
- markdown-it plugin enhancements

## Development Checklist

### 1. Slug normalization
- [ ] `normalizeSlug()` in `src/utils/slug.js`: strip `.html` in addition to `.md`
- [ ] Test: `/foo.html`, `/foo.md`, `/foo` all normalize to `foo`

### 2. Path resolver refactor
- [ ] Refactor `resolveSafePath()` in `src/security/pathGuard.js` into `resolvePageDescriptor(slug, contentRoot)`
- [ ] Returns `{ type: 'html' | 'markdown', filePath, slug, companionPath? }`
- [ ] Resolution order: check `slug.html` exists → check `slug.md` exists → throw ENOENT
- [ ] All existing security checks preserved for both extensions: null byte, double-encoded traversal, `..` segments, within-root validation
- [ ] Extension allowlist: only `.html` and `.md` (fail-closed — no other extensions)
- [ ] `companionPath`: if type is `html` and a `.md` file also exists at the same slug, populate this field (used for "View source" link detection)
- [ ] Export old `resolveSafePath` name as wrapper for backward compatibility if any external caller uses it, or update all callers

### 3. Page service branching
- [ ] `getPage()` in `src/services/pageService.js`: call `resolvePageDescriptor` instead of `resolveSafePath`
- [ ] If descriptor type is `html`: read file directly (`fs.readFile`), compute etag, return `{ html, etag, meta: {}, type: 'html', companionPath }`
- [ ] If descriptor type is `markdown`: existing `renderPage` pipeline (unchanged)
- [ ] Cache key: include descriptor type in key (e.g. `base:slug:html` vs `base:slug:md`) to prevent stale cache when `.html` is added for an existing `.md` slug
- [ ] Alternatively: cache key stays `base:slug` but cache entry stores `type` + `filePath`; on cache hit, verify current descriptor matches cached type/filePath — invalidate on mismatch
- [ ] Max file size check: apply `maxFileSizeBytes` to HTML files too

### 4. Route handler update
- [ ] `pageRoute()` in `src/routes/pages.js`: detect descriptor type from `getPage` result
- [ ] For HTML: skip share-viewer injection and nav-sidebar injection (serve as-is)
- [ ] For HTML: set response header flag (e.g. `res.locals.isHtmlArtifact = true`) before sending, for CSP middleware to detect
- [ ] For markdown: existing flow unchanged
- [ ] Redirect `.html` extension URLs to clean URLs (like current `.md` redirect)

### 5. Scoped CSP
- [ ] `securityHeaders()` in `src/security/headers.js`: refactor to support per-response CSP override
- [ ] Option A: middleware sets default strict CSP; route handler overrides CSP header for HTML artifacts before `res.send()`
- [ ] Option B: middleware checks `res.locals.isHtmlArtifact` and applies relaxed CSP
- [ ] Relaxed CSP for HTML artifacts:
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline'`
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data: https:`
  - `connect-src 'self'`
  - `object-src 'none'`
  - `frame-ancestors 'none'`
  - `base-uri 'self'`
- [ ] Non-CSP security headers unchanged for all responses (`nosniff`, `X-Frame-Options`, `Referrer-Policy`)

### 6. Watch service
- [ ] `watchService.js`: extend `filenameToCacheKey` to handle `.html` files (strip `.html` like `.md`)
- [ ] Watcher callback: trigger on both `.md` and `.html` file changes
- [ ] On change to either extension: invalidate cache for that slug (covers the case where adding `.html` should evict cached `.md` render)

### 7. Index scan
- [ ] `scanPages()` in `src/routes/index.js`: scan `.html` files in addition to `.md`
- [ ] For `.html` files: extract title from `<title>` tag if present, otherwise use slug
- [ ] Same-slug dedup: if both `.html` and `.md` exist, include only once (HTML priority)
- [ ] Mark entries with type so index template can optionally distinguish (e.g. small badge)

### 8. Tests
- [ ] Unit test: `normalizeSlug` strips `.html`
- [ ] Unit test: `resolvePageDescriptor` returns correct type for `.html`-only, `.md`-only, both-exist, neither-exist
- [ ] Unit test: `resolvePageDescriptor` rejects traversal/null-byte for `.html` paths
- [ ] Unit test: `resolvePageDescriptor` populates `companionPath` when both exist
- [ ] Unit test: scoped CSP applied only for HTML artifact responses
- [ ] Unit test: `scanPages` deduplicates same-slug `.html` + `.md`
- [ ] Integration test: request `/foo` when only `foo.md` exists → markdown render
- [ ] Integration test: request `/foo` when only `foo.html` exists → raw HTML with relaxed CSP
- [ ] Integration test: request `/foo` when both exist → HTML served, correct CSP
- [ ] Integration test: request `/foo.html` → redirect to `/foo`
- [ ] Integration test: auth required for HTML pages (no bypass)
- [ ] Integration test: share token works for HTML pages

## Assumptions

- [ ] HTML files in the content directory are trusted agent-authored content, not user uploads — **guaranteed** by deployment model (only the agent writes to `contentDir`)
- [ ] HTML files are complete documents (include their own `<html>`, `<head>`, `<body>`) — **convention**, not enforced; Pages serves whatever is in the file
- [ ] Share tokens bind to canonical slugs — **guaranteed** by current implementation (`verifyShare` uses the slug from the URL path, which is already normalized)
- [ ] `fs.watch` recursive mode fires for `.html` file changes — **guaranteed** on Linux (inotify); same mechanism already used for `.md`

## Acceptance Checklist

- [ ] `npm test` passes (all existing + new tests)
- [ ] Request `/slug` with only `.md` → renders markdown (no regression)
- [ ] Request `/slug` with only `.html` → serves HTML with relaxed CSP
- [ ] Request `/slug` with both → serves HTML; companion `.md` still accessible at `/slug.md` (redirects to `/slug` which shows HTML — or: provide raw API access?)
- [ ] Request `/slug.html` → 301 redirect to `/slug`
- [ ] Auth required: unauthenticated request to HTML page → login redirect
- [ ] Share token: valid share token for slug → HTML page accessible
- [ ] CSP: HTML page response has `script-src 'self' 'unsafe-inline'`; markdown page has `script-src 'self'`
- [ ] Index page lists HTML-only pages with correct title
- [ ] Cache invalidation: add `.html` for existing `.md` slug → next request serves HTML
- [ ] No regressions in existing markdown pages, login, share, todo boards
