# Changelog

## [0.7.0] - 2026-07-02

### Added
- **Feishu-style document management console** (#95): the authenticated console's page-card grid is replaced by a folder tree + row list derived purely from `uri` path prefixes. Supports drag-to-move (native HTML5 DnD, changes the uri prefix), inline title rename (title only, decoupled from uri), and client-side New folder (materializes when a document is dropped in; empty folders are not persisted). The Register page button and dialog are removed — registration is CLI-only via `pages.js register`.
- **Local DB agent CLI for Pages registration/sharing** (#77, #78): `src/cli/pages.js` provides one agent-facing CLI for `register`, `list`, `share`, `shares`, `unshare`, and `allow-root add`, with JSON output and compatibility forwarding from `external-files.js`. Registration uses the shared `registerLogicalPage()` four-gate validation path; the share URL base is configurable (`config.publicBaseUrl`).
- **`PATCH /api/pages/:pageId`** (#95): admin-authenticated move (uri change, uniqueness-checked) and rename (title change) endpoint; the pages list API now returns `pageId`.
- **Back to console** icon button on the authenticated doc viewer top bar (#94) — hidden on share pages and for unauthenticated visitors.
- **Copy-link actions** for active shares in the console (#80) and in the page share dialog (#88).
- **Viewer markdown upgrades** (#92): fenced code blocks get a header bar with language label + copy button; four-tone callouts (`> [!NOTE]`-style info / tip / warn / ok) with Lucide SVG icons.

### Changed
- **BREAKING — stable `page_id` primary key** (#95): `logical_pages` is rebuilt around an internal `page_id` (uuid) primary key with `uri` demoted to a mutable unique column; `shares`/`share_sessions` are re-keyed from slug to `page_id`, so **share links survive page moves and renames**. A one-time idempotent startup migration backfills uuids; **legacy slug-keyed share rows are dropped** (not convertible) and the legacy `shares.json` import is removed. Source files on disk never move — move/rename only updates DB state.
- **Viewer UI modernization** (#91, #92, #93): left navigation sidebar + top toolbar redesign on the doc viewer, sticky glass header with responsive narrow-screen (375px) convergence, and a unified 34×34 icon-button family across viewer and admin (theme / logout / copy actions).
- **Console recolor** (#94): near-black pills and hover states (a `--color-code-bg` leak into UI surfaces) replaced with new `--color-status-bg` / `--color-hover-bg` tokens; the console now uses a single indigo accent.
- **Sidebar navigation sources from the logical page registry** (#79) instead of scanning the filesystem.

### Fixed
- Owner direct views resolve shared assets (#76).
- Share asset signature slug normalization — fixes share-image 403s from the `p/` prefix mismatch (#89).

### Security
- **Auth fails closed when no password is configured** (#82).
- **Page serving and asset resolution are restricted to registered pages** (#83, #84).
- **Legacy `?token=` share tokens deprecated and the bypass removed** (#86, #90); legacy pages routes cleaned up (#81).

## [0.6.0] - 2026-06-30

### Added
- **In-place share rendering + per-asset signed access** (#73): Share pages (`/s/:tokenId`) now render server-side with HTTP 200 and an injected `<base href>` so the address bar stays on the share URL instead of redirecting. Referenced images are served through a new per-asset signed endpoint (`/assets/:uri?path=&exp=&sig=`) whose HMAC signature binds the logical uri, the resolved real path, the expiry, and the tokenId; each asset request re-validates via realpath / allowed-root / extension checks, and links are rejected once the share expires or is revoked. The directory-level `share_scope` cookie is removed entirely.

### Changed
- **Authenticated root is the admin console** (#73, F1): the authenticated `/` is now the Pages admin console and the separate `/admin` mount is removed. The page list is sourced solely from the DB registry.
- **Admin console redesign** (#72): The admin React console was rebuilt for a beautiful, human-friendly experience using the existing Pages design tokens (GitHub/Linear style). Adds a centered max-width layout, card surfaces, a proper button system (the Register/Search buttons previously fell back to unstyled browser defaults — most visible as broken white buttons in dark mode), styled inputs with focus rings, field hints, success/error toasts, a polished empty state, and skeleton loading. Page rows are now cards showing an access-mode badge, component tag, and relative "updated" time. Share-link creation gained an expiry selector (24h / 7d / 30d / permanent), an inline result with one-click copy + expiry, and "copied" feedback. The login page was elevated to match (logo, vertical centering, soft shadow, focus ring).

### Fixed
- **Share cookies `SameSite=Strict` → `Lax`** (#72): `__Host-share_access` and `__Host-share_scope` cookies are now `SameSite=Lax` so share links open correctly inside IM in-app browsers (Telegram/Lark/etc.), which a top-level navigation from another origin would otherwise drop under `Strict`. The admin session cookie remains `SameSite=Strict`.

## [0.5.0] - 2026-06-27

### Added
- **HTML files in external-files registration** (#69): External-files registration now accepts `.html` sources. An `.html` source is linked at a `<slug>.html` path and rendered as a full-page HTML artifact (type `html`), instead of being misrouted through the Markdown pipeline. The symlink extension is now derived from the source file rather than hardcoded to `.md`, so future non-markdown source types register correctly.

## [0.4.2] - 2026-06-25

### Changed
- **Interview questions template side-by-side layout** (#66): Question blocks now use CSS Grid two-column layout — left column for question/notes/follow-ups, right column for reference answers (good/bad indicators + notes). Content width expanded to 1260px. Responsive fallback to single column below 900px.

## [0.4.1] - 2026-06-25

### Added
- **Interview questions HTML template** (#64): New `interview-questions.html` in `templates/html/` for structured interview question guides — candidate info card, prior round summary, core hypotheses, numbered question blocks with interviewer notes/follow-ups, pacing notes, judgment framework table, and badge variants (required/new/optional).

## [0.4.0] - 2026-06-25

### Added
- **Pages CLI** (#61): `src/cli/pages.js` with three commands — `templates` (list available HTML templates), `create --template <name> --slug <path>` (create page from template in correct content directory), `share <slug> --duration <dur>` (create public share link). Eliminates wrong-directory and manual-template-copy failure modes for agents.
- **SKILL.md CLI quick-start**: Added "Creating HTML Pages (CLI)" section at the top of SKILL.md for discoverability.

### Security
- Path traversal guard (`resolveSafePath()`) on both `create` and `share` commands — rejects slugs containing `..` segments.
- `share` command respects `sharing.enabled=false` configuration.

## [0.3.1] - 2026-06-24

### Added
- **SKILL.md references for HTML templates** (#57): Added References table and HTML Report Templates section so agents can discover `references/html-rendering.md` and the 4 HTML report templates.
- **SVG data visualization in HTML templates** (#58): Upgraded all 4 HTML report templates with inline SVG chart placeholders — bar charts, pie charts, radar charts, architecture diagrams, and Gantt timelines. Added a Data Visualization section to `references/html-rendering.md` with copy-paste SVG snippets for 5 chart types, dark mode tips, and responsive guidelines.

## [0.3.0] - 2026-06-21

### Added
- **HTML artifact support** (#28, #29): Serve `.html` files as full-page artifacts with pages chrome (header, sidebar, share controls). HTML artifacts get their own CSP policy allowing inline scripts.
- **Server-side state API for HTML artifacts** (#31, #33): JSON state persistence per artifact with share-token access, enabling interactive HTML pages (checklists, forms) that save state server-side.
- **Static asset serving under auth** (#36): Images and files referenced by pages are served under the same auth/share-token model. Share-scope cookies provide directory-level isolation with HMAC binding.
- **Short share links** (#39): Cookie-native short share URLs (`/s/:tokenId`) replacing long query-string tokens. Automatic cookie refresh on page visit.
- **Artifact attachment uploads** (#48): Server-backed photo/file uploads for HTML artifacts with thumbnail grid, preview dialog, and delete. Uploads scoped per artifact/item key.
- **Editable attachment share links** (#50): Share links can optionally allow photo upload/delete for collaborators without login.
- **Share attachment permission toggle** (#52): In-place toggle to change an existing share link's attachment edit permission without regenerating the URL.

### Fixed
- **HTML artifacts render without pages chrome for share viewers**: Shared HTML artifacts served directly without wrapper iframe for cleaner mobile experience.
- **Trust loopback proxy for rate limiting** (#46): Rate limiter now respects `X-Forwarded-For` behind reverse proxy.
- **Inject `window.__PAGES_BASE` into HTML artifacts** (#34): Browser-base-aware script injection for correct asset resolution under proxied paths.
- **Return 403 for unauthenticated asset requests** (#37): Assets behind auth return 403 instead of redirect loop.
- **Share editable flag in WeChat WebView** (#53): Fixed three compounding issues — ETag 304 returning stale cached HTML, `attachments.js` cached without `data-share-editable` fallback, and missing attribute in `injectShareViewer`. Server now rewrites `_assets/` URLs with version query for cache busting.

## [0.2.0] - 2026-06-14

### Added
- **Folder-aware page navigation** (#18, #26): Pages with path separators in their slug are automatically grouped into collapsible folder sections on the index page, with folder groups displayed above ungrouped pages. Sidebar navigation groups pages by folder with the current page's folder auto-expanded. Breadcrumb shows full folder path. Shared `buildPageTree()` utility in `src/utils/pageTree.js`.
- **Mermaid diagram rendering** (#23): Render Mermaid diagrams in Markdown files using fenced code blocks. Lazy-loaded, shared module, cache-busted. Includes entity decoding security fix.
- **Persistent sessions with remember-me** (#25): Login sessions persist across server restarts via SQLite-backed session store. "Remember me" checkbox extends session to 30 days.

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
