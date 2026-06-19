# Dev Plan: Serve Static Assets Under Pages Auth (#35)

## Summary

Enable pages to serve static assets (images, fonts, CSS, JS, PDF) from the content directory under the same auth model as pages. Share-token viewers can access assets in the same directory as the shared page, via a share-scope cookie set during page access.

## Scope

**In scope:**
- New MIME type map (`src/utils/mime.js`)
- New asset resolution function in `pathGuard.js`
- New standalone asset route (`src/routes/asset.js`, registered before catch-all page route)
- Share-scope cookie mechanism: page share-token access sets a scoped cookie → asset requests use the cookie
- Auth: session-authenticated users access all assets; share-scope cookie grants same-directory access
- Proper Content-Type, ETag, and cache headers for assets
- Size limit per existing `maxFileSizeBytes` config

**Out of scope:**
- Directory listing
- Asset upload API
- Image transformation/resizing
- Asset-specific share tokens (reuse page share tokens via cookie)

## Constraints

**Asset file extension allowlist** (not configurable in Phase 1):
`.jpg`, `.jpeg`, `.png`, `.gif`, `.svg`, `.webp`, `.ico`, `.css`, `.js`, `.pdf`, `.woff`, `.woff2`, `.ttf`, `.eot`

**Share-token asset scope** (deliberate product constraint): a share token for slug X grants access to assets in the same directory as X. Root-level page token → root-level assets only. Nested page token (e.g. `docs/guide`) → assets under `docs/` only. Root token cannot access nested assets; nested token cannot access sibling directories or root assets.

## Contracts

### The browser relative-URL problem

When a shared page at `/pages/renovation-checklist?token=abc` contains `<img src="kitchen-ref.jpg">`, the browser requests `/pages/kitchen-ref.jpg` WITHOUT `?token=abc`. The token is not inherited by relative resource URLs.

**Solution: share-scope cookie.** When a share token successfully loads a page, set a short-lived HttpOnly cookie that encodes the allowed directory scope. The browser automatically sends this cookie on subsequent same-origin asset requests.

### Share-scope cookie

- Cookie name: `__Host-share_scope` (host-prefixed for security)
- Value: `<directory>:<expiresAt>:<hmac>` — where directory is the asset scope (e.g. empty string for root, `docs` for nested), expiresAt is Unix ms, hmac is HMAC-SHA256 of `directory:expiresAt` signed with the share secret
- Set when: a share token successfully accesses a page (in auth middleware page share-bypass block)
- TTL: matches the share token's remaining lifetime, capped at 1 hour
- Attributes: `HttpOnly; Secure; SameSite=Strict; Path=/`
- Cleared when: the user logs in with a real session (avoids scope leakage)

### Asset detection

- A request is an asset request if the URL path ends with a recognized extension from the allowlist
- Detected by the standalone asset route (`setupAssetRoute`), registered BEFORE the catch-all page route
- If the path has an asset extension: serve the file (or 404 if not found)
- If not an asset extension: `next()` to page route (no interference)
- The existing `.md` and `.html` extension redirect logic in the page route is unchanged

### Asset resolution

- New `resolveAssetPath(slug, contentRoot)` in `pathGuard.js`
- Reuses existing `validateSlug` for traversal protection
- Extracts extension, checks against allowlist
- Resolves path within contentRoot, verifies it doesn't escape
- Returns `{ filePath, mimeType }` or throws ENOENT / PathViolationError

### Asset serving

- Read file as Buffer, set `Content-Type` from MIME map
- Generate ETag from content hash (reuse `generateEtag` — verified: works on Buffer)
- 304 support (If-None-Match)
- `Cache-Control: public, max-age=3600` for authenticated users, `no-store` for share-scope viewers
- Respect `maxFileSizeBytes` — reject files over limit with 413

### Auth for assets

Three paths, checked in order:
1. **Session-authenticated** (existing session cookie): access all assets. No change.
2. **Share-scope cookie** (`__Host-share_scope`): validate HMAC, check expiry, check asset directory matches cookie scope. If valid: set `viewerType='share'`, serve asset.
3. **No auth**: 302 redirect to login (existing behavior).

Share-scope cookie bypass: only for GET/HEAD methods (P2 fix).

The asset route does NOT accept `?token=` directly — tokens are for pages and state API. Assets use the cookie set during page access.

### Auth middleware changes

- Existing page share-bypass block (GET/HEAD, non-`/api/`): additionally set `__Host-share_scope` cookie when a share token validates. Derive directory from the token's slug.
- No new share-token bypass block for asset paths — assets use the cookie, not the token.
- New: in the auth middleware, after the share-token blocks and before the session check, add a share-scope cookie check for asset paths. If the cookie is valid and the asset is in scope, set `viewerType='share'` and `next()`.

## Development Checklist

- [ ] Create `src/utils/mime.js` — MIME type map and extension allowlist
  - `isAssetExtension(ext)` — check against allowlist
  - `getMimeType(ext)` — return Content-Type string
- [ ] Add `resolveAssetPath(slug, contentRoot)` to `src/security/pathGuard.js`
  - Validates slug, extracts extension, checks allowlist via `isAssetExtension`
  - Resolves path within contentRoot (traversal protection)
  - Returns `{ filePath, mimeType }`
- [ ] Add share-scope cookie helpers to `src/sharing/share-manager.js`
  - `createShareScopeCookie(slug, tokenExpiresAt, secret)` — derive directory, compute HMAC, return cookie value + attributes
  - `verifyShareScopeCookie(cookieValue, assetPath, secret)` — validate HMAC, expiry, directory scope match
- [ ] Modify `src/security/auth.js`
  - In page share-bypass block: after setting `viewerType='share'`, also set `__Host-share_scope` cookie (call `createShareScopeCookie`)
  - Add new block before session check: for asset paths (GET/HEAD only), check `__Host-share_scope` cookie via `verifyShareScopeCookie`. If valid and asset in scope: set `viewerType='share'`, `next()`. If invalid: fall through.
- [ ] Create `src/routes/asset.js` — standalone asset route
  - `setupAssetRoute(app, config)` — register GET handler for `/:slug(*)` that only matches asset extensions
  - Resolve asset via `resolveAssetPath`
  - Check size limit, read file, set headers (Content-Type, ETag, Cache-Control), send
  - 304 handling
  - Non-asset extensions: `next()`
- [ ] Register in `src/index.js` — `setupAssetRoute(app, config)` before `app.get('/:slug(*)', pageRoute(config))`
- [ ] Write tests

## Test Checklist

### Asset serving (authenticated)
- [ ] GET `/image.jpg` → 200 with `Content-Type: image/jpeg`
- [ ] GET `/image.png` → `Content-Type: image/png`
- [ ] GET `/style.css` → `Content-Type: text/css`
- [ ] GET `/doc.pdf` → `Content-Type: application/pdf`
- [ ] ETag returned, 304 on matching If-None-Match
- [ ] File over maxFileSizeBytes → 413
- [ ] Non-allowlisted extension (`.exe`) → falls through to page route → 404

### Auth
- [ ] Unauthenticated GET asset → 302 redirect
- [ ] Session-authenticated GET asset → 200
- [ ] PUT/DELETE asset → 302 (only GET/HEAD served)

### Share-scope cookie flow (full browser simulation)
- [ ] Share-token page access sets `__Host-share_scope` cookie in response
- [ ] Subsequent asset request with cookie (no token) → 200 for same-directory asset
- [ ] Cookie for root scope cannot access nested asset → 302
- [ ] Cookie for nested scope cannot access root asset → 302
- [ ] Cookie for nested scope cannot access sibling directory asset → 302
- [ ] Expired cookie → 302
- [ ] Tampered cookie (wrong HMAC) → 302

### Path security
- [ ] Path traversal (`../../../etc/passwd.jpg`) → 400
- [ ] Null byte in path → 400
- [ ] Double-encoded traversal → 400

### No regression
- [ ] Markdown pages still render
- [ ] HTML artifacts still serve (with `__PAGES_BASE` injection)
- [ ] `.md` and `.html` extension redirects still work
- [ ] State API (authenticated + share-token) still works
- [ ] Share-token page access still works
- [ ] All existing tests pass

## Assumptions

- `readFile` on binary files returns a Buffer — guaranteed by Node.js `fs` API
- `generateEtag` works on Buffer content — verified: `crypto.createHash('sha256').update(buffer)` is valid
- Content directory may contain non-page files — guaranteed by current usage
- The existing `maxFileSizeBytes` config (default 1MB) is appropriate for images — reasonable for web assets
- `__Host-` cookie prefix requires Secure + Path=/ — guaranteed by our HTTPS setup via Caddy
- Browsers send same-origin cookies on subresource requests (images, CSS) — guaranteed by HTTP spec when SameSite=Strict and same origin

## Acceptance Checklist

- [ ] Move `kitchen-ref.jpg` from `/img/renovation/` back into pages content directory
- [ ] Update `renovation-checklist.html` to use relative path `src="kitchen-ref.jpg"`
- [ ] Authenticated: page loads, image visible
- [ ] Create share link for `renovation-checklist`
- [ ] Open share link in incognito: page loads, image also loads (via share-scope cookie)
- [ ] Open a different page's asset URL in same incognito session: 302 (out of scope)
- [ ] `npm test` — all tests pass
- [ ] No regression on existing pages/API/state functionality
