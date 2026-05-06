# Changelog

## [0.1.8] - 2026-05-06

### Added
- **Copy raw Markdown button** (#21): Copy the original Markdown source text from the page header. Correctly hidden from share viewers.

### Fixed
- **Dynamic base-path auth routes** (#20): Removes hardcoded `/pages` base URL. All routes dynamically resolve from `X-Forwarded-Prefix` header, supporting both Caddy stripped-prefix proxy and direct local access. New `browser-base.js` module with prefix validation, open-redirect prevention, and dot-segment escape protection. Cache keys include browser base to prevent cross-prefix poisoning. 7 new tests added.

## [0.1.7] - 2026-04-27

### Added
- External file registration for component-owned Markdown files, with source allowlists and registry locking

### Fixed
- Hardened external file registration against malformed slugs, unknown symlinks, parent path conflicts, and unregister target drift

## [0.1.6] - 2026-04-07

### Added
- `CLAUDE.md` with project guidelines, source structure, security rules, and release checklist

## [0.1.5] - 2026-04-07

### Added
- TODO kanban board: interactive web-based task management with drag-and-drop columns
- Tab-based navigation on index page (Pages / Todo tabs) with URL state sync
- Security: `isSafeUrl()` link validation and `sanitizeTodoInput()`/`sanitizeLine()` to prevent XSS and markdown structure injection (code review by Jinglever)

### Fixed
- `resolveBoardPath` now handles object config format (`board.file`)
- Tab switching JS moved to external `tabs.js` for CSP `script-src 'self'` compliance (inline script was silently blocked)
- Invalid `tab` query parameter (e.g. `?tab=foo`) no longer causes blank page — falls back to `pages`

## [0.1.4] - 2026-03-23

### Added
- Navigation sidebar: slide-out drawer from left screen edge for quick article switching
- Hamburger toggle button in header to open/close pages list
- Overlay backdrop when drawer is open (click to close)
- Independent TOC scrolling: right-side table of contents scrolls independently from page content
- Screenshot added to README

### Fixed
- Inline nav toggle script blocked by CSP `script-src 'self'` — moved to external `nav.js`
- Replaced broken logo in README with Zylos mascot

## [0.1.3] - 2026-03-23

### Fixed
- Page index crash when frontmatter `date` is a YAML Date object (fix was lost in v0.1.2 squash merge)

## [0.1.2] - 2026-03-23

### Added
- Document sharing: public share links with HMAC-signed stateless tokens
  - Time-limited (24h/7d/30d) and permanent share options
  - Share modal UI with create/copy/list/revoke functionality
  - REST API: POST/DELETE/GET with CSRF protection
  - Auth bypass narrowly scoped to GET/HEAD on document routes only
  - Security: 16-byte tokenId, timing-safe compare, Referrer-Policy no-referrer
  - Permanent shares disabled by default (`sharing.allowPermanent` config)
  - Hourly cleanup of expired share records, revoked tombstones retained
- `sharing` config section (`enabled`, `allowPermanent`)

### Fixed
- Cache not updating after `sed -i` / vim edits (write-to-temp-then-rename pattern). Added mtime validation on cache reads as safety net for `fs.watch` limitations on Linux
- Page index crash when frontmatter `date` field is a YAML Date object instead of string. `gray-matter` auto-parses dates; now converts to ISO string before sorting

## [0.1.1] - 2026-03-22

### Fixed
- PM2 ecosystem config: `cwd` path used `zylos-pages` instead of `pages` (component install name), causing service startup failure on fresh installs

## [0.1.0] - 2026-03-22

### Added
- Markdown rendering with GFM support (tables, task lists, strikethrough)
- Code syntax highlighting via shiki (VS Code quality)
- YAML frontmatter parsing (title, description, date, tags)
- Auto-generated table of contents for long documents
- Directory index page listing all available pages
- LRU cache with TTL and singleflight dedup
- Content-hash ETag for HTTP caching
- File watcher for automatic cache invalidation
- Dark/light theme with auto-detection and manual toggle
- Cookie-based session authentication with scrypt password hashing
- CSRF protection (strict Origin/Referer validation)
- Per-IP brute-force protection (5 attempts/min)
- Login/logout pages with sign-out button
- Responsive layout with mobile table scroll fix
- Security: path traversal protection, HTML sanitization, CSP headers
- Rate limiting and file size limits
- Print stylesheet
- Structured JSON logging for observability

### Fixed
- Caddy reverse proxy strip_prefix for correct path routing
- 404 handling with ENOENT propagation from worker
- Cache invalidation and render timeout (P0 blockers)
- Post-login redirect behind HTTPS reverse proxy
- Logout CSRF hardening, Cache-Control no-store override
- Corrupted password hash resilience (try/catch in verifyPassword)
- CSP policy, H1 deduplication, cache-busting (CocoClaw review)
