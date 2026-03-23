# Changelog

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
