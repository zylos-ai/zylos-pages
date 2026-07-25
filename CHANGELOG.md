# Changelog

## [0.7.6] - 2026-07-25

Closes the other half of the share-link incident follow-up. 0.7.5 made revocation
precise and the live inventory visible; this makes the ledger complete and adds
the lookup that answers "someone just sent me an old link — what was it?".

Note on scope: destroying the plaintext token on revocation was proposed and
**rejected by the owner**. Revocation stays a reversible marker so a mistaken
`unshare <uri>` can still be undone — the one recovery that has actually been
needed. SKILL.md now states that plainly rather than leaving it implied.

### Added
- **`share-info <token-or-url>`**: resolves a share link back to its document, reporting `status` (`active` / `expired` / `revoked`), creation time, duration, expiry, and revocation time. Deliberately resolves expired and revoked links — those are exactly the ones whose origin nobody remembers. Accepts the full `/s/<token>` URL or the bare token id. Unknown tokens and non-token input both fail with `share_not_found`. No such command existed: `shares` only lists live links and `unshare` revokes, so a link in hand could only be traced by opening the SQLite file by hand.

### Changed
- **Expired share rows are no longer deleted.** The hourly job ran `DELETE FROM shares WHERE expires_at != 0 AND expires_at <= now`, so once a timed link lapsed there was no record it had existed — the table was a complete ledger for revocations and amnesiac about expirations, and an inventory count was a snapshot rather than a history. Cleanup is now sessions-only; `share_sessions` rows are still deleted on expiry, since those are transient browser state. Growth from retaining rows is measured, not assumed: ~3.6 shares/day observed over 23 days, ~108 bytes/row, i.e. roughly 0.2 MB/year — no retention cap is set because none is needed at that scale.
- **`revoked` takes precedence over `expired` in reported status.** A link that was revoked and then outlived its expiry still reports `revoked`; the deliberate act should not be quietly rewritten by the passage of time.
- **SKILL.md states that revocation is a reversible marker, not destruction.** Previously it said "revocation is not deletion", which described the row but let the reader assume the credential was gone. It also no longer claims expired links are deleted.
- **`references/pages-cli.md` brought back in sync.** It still described `share --duration permanent` as gated by config (that gate was removed in 0.7.5) and documented neither `unshare --token` nor `shares --all`. Corrected here rather than by adding a commit to the 0.7.5 branch while it was under review.
- **One expiry boundary across the share surface.** The live listings ask SQL for `expires_at > now`, so a row whose expiry equals the current millisecond is already not live; `describeShare()` asked `now > expires_at` and reported that same row `active`. A status contract that contradicts the listing it explains is worse than either answer alone, so expiry is now one predicate (`now >= expires_at`, with `0` meaning permanent) used by the status lookup, the active-record resolver, legacy token verification, and the session check. Sessions, scope cookies and asset signatures share the boundary rule for the same reason.
- **Unregistering a document now leaves a tombstone instead of deleting its share rows.** Retaining expired rows was only half a ledger: `unregister <uri>` deleted every share row for that page, so the moment a document was removed, the links that had exposed it became permanently unattributable — exactly the question this release exists to answer. Keeping the rows is not sufficient on its own, because the uri lives only in the page row being deleted and `page_id` names nothing to a human; the rows are therefore stamped with the page's uri (`shares.origin_uri`) as it goes. Access is unaffected by the change: every path resolves through the page row, so the links died when the page did and still do. `share_sessions` are still deleted — those are what could otherwise still open the page. Found by self-audit and independently in review; the semantics were decided by the owner, not inside the PR.
- **`share-info` reports `document_deleted`, and `shares --all` excludes tombstones.** Status precedence is revoked > document_deleted > expired > active: the deliberate act outranks everything (it is also the only reversible one), and a deleted document outranks a spent clock because it says something about the content rather than the calendar. The underlying facts (`documentDeleted`, `revokedAt`, `expiresAt`) are all returned regardless, so no caller is forced to read the ranking. The live inventory deliberately does not list tombstones: `shares --all` answers "what does this box expose", and a link to a deleted document exposes nothing.
- **Contract change: `unregister` reports `tombstonedShares`, not `removedShares`** (CLI `unregister --json` and `DELETE /api/pages/:pageId`). The number now counts rows kept rather than rows deleted; leaving the old name would tell an operator the links had been purged. No in-tree consumer read the field.

### Tests
- **`test/share-expiry-boundary.test.js` (new).** Five cases pinning the equality instant with a driven clock (real time cannot be parked on one millisecond): live at `expires_at - 1`, agreed-gone at exactly `expires_at` across the status lookup, the active resolver and the live listing, still traceable at `+1`, a permanent share never expired even at instant 0, and a fixture guard proving the row really carries the expiry under test. Verified to **fail** with the old loose `>` restored.
- **`test/share-cli-output.test.js` extended to `share-info`.** Its nine original cases were all `--json`, the exact blind spot that shipped the two 0.7.5 stdout bugs, on the one command whose entire audience is a person holding a link they cannot place. Adds raw-stdout coverage for active, permanent (`Expires: never`, not a 1970 date), expired-but-still-named, revoked-with-timestamp, and the full-URL input form, plus the assertion that an active share prints no `Revoked:` line. Verified: removing the `share-info` branch from the humanizer fails 5 of the 9.
- **Unregister coverage in `test/share-ledger-retention.test.js`.** Five cases for the tombstone: `register → share → unregister → share-info` still naming the historical document; the link being dead by every access path afterwards (`shares --all` empty, per-page listing refusing with `page_missing`, status `document_deleted`); an unrelated page's live share surviving the unregister; revoked-then-deleted keeping `revoked` while still reporting `documentDeleted`; and a negative control where the stamp is cleared by hand, which must degrade to a null uri rather than invent one. Verified: restoring the old `DELETE FROM shares` fails **7** of the suite's tests, including the two pre-existing ones that had locked the deletion in.
- **`test/share-ledger-retention.test.js` (new).** Nine cases: an expired row surviving cleanup; `share-info` resolving expired, active, and revoked links; revoked-then-expired precedence; the full-URL input form; two negative controls (a well-formed but never-issued token, and non-token input, both required to fail rather than return something); and that cleanup still deletes expired sessions, so a narrowed `cleanupShares` cannot be mistaken for a gutted one. The two retention tests were verified to **fail** with the old `DELETE` reinstated — the other seven pass either way, which is the point of separating them.

## [0.7.5] - 2026-07-25

Follow-up to an incident where a routine `unshare <uri>` cleanup revoked two
permanent links that were still in use. The CLI could not express "revoke just
this one", and could not list what links existed at all, so neither the mistake
nor its blast radius was visible before or after the fact.

### Added
- **`unshare --token <token-id>`**: revokes exactly one share. `revokeShare(tokenId)` and `DELETE /api/share/:tokenId` already existed for the web client; the CLI only imported `revokeAllForSlug`, so agents could revoke a whole page but never a single link. Unknown and already-revoked token ids both fail with `share_not_found` — the CLI deliberately does not distinguish them, and the error message says so.
- **`shares --all`**: lists every live share on the instance, with the uri each token exposes. Previously `shares <uri>` could only answer per-page, so "what passwordless links exist on this box right now?" had no CLI answer and required reading the SQLite file directly.

### Changed
- **`sharing.allowPermanent` removed; permanent links are always allowed.** The option defaulted to `false` in code while deployments set it to `true`, so the same command behaved differently per machine with nothing in the CLI surfacing which. If the key is still present in `config.json` it is ignored and startup logs a warning — removing the gate *loosens* behaviour for anyone who had set it to `false`, so that change is announced rather than silent. `createShare()` drops both of its now-dead parameters: `sharingConfig` (only ever read for `allowPermanent`) and `options` (already dead before this change — `canWriteAttachments` has been hardcoded `false` in the function body, so every caller's `options` was silently discarded). Test call sites were passing `{ allowPermanent: false }` positionally and would have silently re-bound it to `options` otherwise.
- **SKILL.md no longer presents passwordless sharing as a routine step.** The HTML quick-start previously ran `share ... --duration 30d` directly under a `# Create a public share link (no login required)` comment, which is where the default-share behaviour came from. Adds a Sharing section stating plainly that `/s/<token>` bypasses login, that registering (password-protected) is the default, and that `unshare <uri>` revokes every token on a page.
- **`--all` is parsed as a boolean flag.** `parseArgs` special-cased only `--json`, so `shares --all` failed with "missing value for --all". Replaced with a `BOOLEAN_FLAGS` set; flags outside it are unchanged and still consume the next argument.

### Tests
- **`test/share-permanent.test.js` (new).** The suite had no `permanent` case whatsoever, so it could not have caught the old gate or its removal. Covers permanent shares from a config with no `sharing` key (the exact shape the removed default governed), their appearance in `shares --all`, and — as a negative control — that an unknown duration is still rejected. Verified to fail when the old gate is reinstated.
- **`test/share-cli-output.test.js` (new).** Every existing share test asserted on `--json`, so the default human-readable path — the one an operator reads during an incident — had no coverage at all, which is exactly how both output bugs below shipped green. Asserts on raw stdout for `shares --all` and `unshare --token`, plus a negative control that per-page `shares <uri>` does *not* grow a uri column. Three of the four fail without the fix.

### Fixed
- **Hourly-cleanup comment corrected.** It claimed to clean up "expired/revoked shares", but the SQL only ever deleted expired rows — revoked rows stay forever. The comment implied revocation destroys the record, which is the opposite of what happens (and is why two revoked links could be restored by hand).
- **`shares --all` non-JSON output now prints the uri for each token.** It listed token id and expiry only, so the command built to answer "what is exposed on this box?" could not say *which document* each link exposed — the default output was unusable for the one job the flag exists for. Per-page `shares <uri>` is unchanged; the uri is implied there.
- **`unshare --token` no longer prints `revoked 1 share(s) for undefined`.** The `--token` branch never put a uri in its result, and the humanizer interpolated the missing field. It now resolves the share before revoking (afterwards it is no longer active and cannot be looked up) and falls back to the token id when the page row is gone.

### Known limitations (not addressed here)
- Expired shares are hard-deleted, so the `shares` table is a snapshot rather than a full ledger of every link ever minted. Fixed in 0.7.6.
- `token_id` is the secret in the `/s/<token>` URL and is stored in plaintext, so a revoked row still holds a re-activatable credential. **This is now a deliberate decision, not a pending item:** the owner chose to keep revocation reversible, because it is what allowed a mistaken bulk `unshare <uri>` to be undone. 0.7.6 states that contract explicitly in `SKILL.md`.
- **`canWriteAttachments` is handled inconsistently across the HTTP API**: `POST /api/share` accepts `true` and silently ignores it, while `PATCH /api/share/:tokenId` rejects the same value with 410. Pre-existing, untouched here, and deliberately out of scope for a CLI-focused change — fixing it means changing HTTP response codes, which needs its own review and its own tests. Tracked as a follow-up rather than left undecided.

## [0.7.4] - 2026-07-06

### Fixed
- **Cookie clash between multiple pages instances on one host** (#104): the session and share cookies were `__Host-` prefixed, which mandates `Path=/`, so two instances on the same domain (e.g. `/pages` and `/coco/pages`) shared one cookie slot — logging into one logged the other out, and each instance received the other's session token. Cookies are now `__Secure-` prefixed with `Path` bound to the instance's mount prefix (from `X-Forwarded-Prefix`, falling back to `/` for direct access), so each instance's cookies stay in its own subtree. Login/logout additionally expire the legacy host-wide `__Host-*` cookie names so stale cookies from earlier versions don't linger.

## [0.7.3] - 2026-07-02

### Fixed
- **Login session takes precedence over share-access cookies** (#102): the auth middleware now checks the login session before the share-access cookie bypass, so an authenticated user always gets the authenticated (shell) view on `/p/<uri>` even when the browser still carries a `__Host-share_access` cookie from a previously opened share link. Previously the share bypass ran first and misclassified logged-in owners as share visitors, serving the shell-less raw view. The share-access cookie remains the unauthenticated fallback and deliberately keeps matching `/p/` logical routes — share views carry `<base href=".../p/<uri>">`, so anchor/TOC navigation from a share depends on it.

## [0.7.2] - 2026-07-02

### Changed
- **Console UI refinements** (#99): console top bar now uses the same indigo mark + wordmark brand as the viewer sidebar, with a muted version caption read from `package.json` at startup; doc row titles drop to weight 500 (hierarchy via color depth) and folder names to 600 for cleaner CJK rendering; the admin container widens adaptively to `min(1200px, 100% - 48px)` while ≤600px keeps the prior full-width layout.
- **Viewer sidebar version caption + system-first font stack** (#100): the viewer sidebar brand shows the same version caption, with the version read shared via `src/lib/app-version.js`; `--font-body` now leads with `system-ui` and adds a full CJK fallback chain (`PingFang SC` → `Hiragino Sans GB` → `Microsoft YaHei` → `Noto Sans SC`), dropping the machine-dependent `Inter` entry and fixing Windows CJK falling through to SimSun; adds `-moz-osx-font-smoothing: grayscale`.

## [0.7.1] - 2026-07-02

### Added
- **Logical page unregister** (#97): `src/cli/pages.js unregister <uri> [--json]` removes the logical page registration and returns `page_missing` for absent pages.
- **`DELETE /api/pages/:pageId`** (#97): owner-authenticated endpoint reuses the same unregister service path for admin deletion.

### Changed
- Unregister/delete removes `share_sessions` and `shares` rows directly by stable `page_id` in the same transaction as the `logical_pages` delete, leaving the source file on disk untouched.

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
