# Dev Plan: audio/video page assets (#207), remembered folder state (#208), full admin list (#209)

## Summary
Three problems Kevin's team hit in daily use. One branch, one PR, one commit per issue
(`feat(assets): ... (#207)`, `feat(admin): ... (#208)`, `fix(pages): ... (#209)`).
No version bump in this PR (bump is a separate release PR, as with #198); add entries
under `## [Unreleased]` in CHANGELOG.md.

Developer: Codex. Reviewer / acceptance: luna.coco. Merge decision: Howard.

## #207 — HTML pages can play audio/video files placed next to them

### Scope
1. `src/utils/mime.js`: add `.mp3 audio/mpeg`, `.m4a audio/mp4`, `.ogg audio/ogg`,
   `.wav audio/wav`, `.mp4 video/mp4`, `.webm video/webm`. This automatically makes them
   eligible for relative-reference rewriting/signing (`asset-resolver.js`) and for the
   403-instead-of-login behaviour in `security/auth.js` — verify both still behave.
2. `src/routes/logical-assets.js`: media types (audio/*, video/*) are **streamed** from disk
   with HTTP Range support (200 full, 206 partial, 416 unsatisfiable, `Accept-Ranges: bytes`,
   correct `Content-Range`/`Content-Length`, HEAD works). Do not read media files into memory
   and do not hash full content for the ETag (use size+mtime). Non-media assets keep today's
   code path unchanged.
3. Size limit for media: a separate `security.maxMediaFileSizeBytes` (default 200 MiB),
   because the existing `maxFileSizeBytes` (4 MiB on some instances) is a render ceiling and
   would reject ordinary tracks. Document in config docs/README.
4. CSP: add an explicit `media-src 'self'` to `HTML_ARTIFACT_CSP`, `SANDBOXED_HTML_ARTIFACT_CSP`
   and the non-outbound-denied branch of `sandboxedHtmlArtifactCsp` (today it only works via
   the `default-src 'self'` fallback). The outbound-denied branch already has `media-src 'self' data:`.
5. Signed URL lifetime: owner asset signatures live 5 minutes, share asset signatures 1 hour.
   A media element issues new Range requests long after page load (resume after pause,
   seek, next track of a 60-min album), so those would 403. For media extensions only, sign
   with a longer lifetime: 6 hours, still capped by the share's own expiry. Images/CSS/JS keep
   their current lifetimes.
6. Auth unchanged: owner session or valid owner/share signature, same as other page assets.

### Out of scope
Transcoding, uploads of media through the API, attachment pages, changes to non-media assets.

## #208 — Admin list remembers collapsed folders

### Scope
1. `src/admin/Admin.jsx`: initialise `collapsed` from `localStorage`, write on every toggle.
   Key must be per instance — several pages instances can share one origin under different
   mount prefixes — e.g. `zylos-pages:collapsedFolders:<browser base path>`.
2. Prune stored paths that no longer exist, **only** when the full (unfiltered) list has
   loaded; a search result showing fewer folders must not erase remembered state.
3. Corrupt/unavailable localStorage (bad JSON, storage disabled) falls back to "all expanded"
   without throwing.
4. Rebuild the committed bundle `assets/admin.js` with `npm run build:admin`.

### Out of scope
The sidebar `<details>` folders (issue marks it optional; server-rendered, separate change).

## #209 — Admin list and CLI show all pages

### Scope
1. `src/pages/page-store.js` `searchLogicalPages`: empty query returns all pages (no LIMIT);
   a non-empty title search keeps its LIMIT 100. Keep the change minimal — open PR #202
   edits the search branch of the same function; don't touch the LIKE/escape logic.
2. `GET /api/pages` returns all pages for the admin list plus a `total` count; admin list
   shows the total (e.g. "520 pages").
3. CLI `pages list`: all pages by default, optional `--limit N`; update
   `references/pages-cli.md` / SKILL.md if the CLI usage is documented there. (Open PR #201
   also edits `src/cli/pages.js` — keep the diff local to the list command.)
4. Check that 500+ pages render fine in the admin tree (no per-row expensive work).

## Test checklist (run only affected test files; full suite is left to GitHub CI)
- #207: extend `test/asset-route.test.js`: mp3 200 with right Content-Type; Range `bytes=0-99`
  → 206 + headers + exact bytes; open-ended and suffix ranges; out-of-range → 416; HEAD;
  file larger than `maxFileSizeBytes` but under media limit → served; over media limit → 413;
  unauthenticated → 403; share-signed and owner-signed URLs accepted; media signature
  lifetime 6h (capped by share expiry) while image signature lifetime unchanged.
  `test/html-artifacts.test.js` (or equivalent): `<audio src="a.mp3">` and
  `<source src="a.m4a">` are rewritten/signed; CSPs contain `media-src 'self'`.
- #208: unit-level test of the load/save/prune helper (pure function extracted from the
  component), including the "filtered list must not prune" case and bad JSON.
- #209: page-store test with >100 pages: empty query returns all, title search still capped;
  `/api/pages` returns all + total; CLI list returns all and honours `--limit`.

## Assumptions
- Browsers fetch `<audio>`/`<video>` with Range requests and no CORS mode unless
  `crossorigin` is set; sandboxed (opaque-origin) frames therefore need signed URLs, not cookies. (Verify in real Chromium.)
- Page folder paths are stable strings from page URIs (so they are valid storage keys).
- 520 pages × current row size is small enough to return in one JSON response (no pagination needed).

## Acceptance checklist (luna.coco, in an isolated instance, real Chromium)
- [ ] A registered HTML page with relative `<audio controls src="a.mp3">` plays, seeks
      (206 seen in network log) and plays a second track — owner view (sandboxed frame) and share link.
- [ ] A ~5 MB mp3 plays on an instance with `maxFileSizeBytes` = 4 MiB.
- [ ] Resuming playback after the old 5-min owner signature window still works (simulate with a shortened clock or by checking signature exp ≥ 6h).
- [ ] Unauthenticated direct mp3 request → 403.
- [ ] Collapse folders, reload → state kept; search, clear search → state kept; two instances under different base paths don't share state. Screenshots before/after reload.
- [ ] With >100 pages (seed ~520): admin list folder count equals sidebar folder count; total shown; `pages list` count matches.
- [ ] Related test files pass; lint/build clean; `assets/admin.js` rebuilt from source.
