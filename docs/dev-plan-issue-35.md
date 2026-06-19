# Dev Plan: Serve Static Assets Under Pages Auth (#35)

## Summary

Enable pages to serve static assets (images, fonts, CSS, JS, PDF) from the content directory under the same auth model as pages. Share-token viewers can access assets in the same directory as the shared page.

## Scope

**In scope:**
- New asset resolution function in `pathGuard.js`
- New asset serving route (before the catch-all page route)
- Auth: session-authenticated users can access all assets; share-token scoped to same directory
- Auth middleware: extend share-token bypass for asset paths
- Proper Content-Type, ETag, and cache headers for assets
- Size limit per existing `maxFileSizeBytes` config

**Out of scope:**
- Directory listing
- Asset upload API
- Image transformation/resizing
- Asset-specific share tokens (reuse page share tokens)

## Constraints

**Asset file extension allowlist** (not configurable in Phase 1):
`.jpg`, `.jpeg`, `.png`, `.gif`, `.svg`, `.webp`, `.ico`, `.css`, `.js`, `.pdf`, `.woff`, `.woff2`, `.ttf`, `.eot`

**Share-token asset scope**: a share token for slug X grants access to assets whose path starts with the same directory prefix as X. For root-level pages (e.g. `renovation-checklist`), this means all root-level assets. For nested pages (e.g. `docs/guide`), this means assets under `docs/`.

## Contracts

### Asset detection
- A request is an asset request if the URL path (after slug normalization) ends with a recognized extension from the allowlist
- Asset requests are intercepted in the page route handler before attempting page resolution
- The existing `.md` and `.html` extension redirect logic runs first (unchanged)

### Asset resolution
- New `resolveAssetPath(slug, contentRoot)` in `pathGuard.js`
- Validates slug (reuse existing `validateSlug`)
- Extracts extension, checks against allowlist
- Resolves path within contentRoot, verifies it doesn't escape (same traversal protection as pages)
- Returns `{ filePath, extension, mimeType }` or throws ENOENT

### Asset serving
- Read file, set `Content-Type` from extension-to-MIME map
- Generate ETag from file content hash (reuse `generateEtag`)
- 304 support (If-None-Match)
- `Cache-Control: public, max-age=3600` for authenticated users, `no-store` for share viewers
- Respect `maxFileSizeBytes` — reject files over limit with 413

### Auth for assets
- Session-authenticated users: access all assets (same as pages)
- Share-token users: extend auth middleware share-token bypass to recognize asset paths
  - Extract the asset's directory from the URL path
  - Derive a "directory slug" (everything before the last `/`, or root for top-level assets)
  - For root-level assets: verify the share token's slug shares the same root level (both have no `/` in slug)
  - For nested assets: verify the share token's slug starts with the same directory prefix
  - Call `verifyShare(token, pageSlug)` where `pageSlug` is the share token's embedded slug — but since we don't know which page the asset belongs to, we use a directory-based approach: the auth middleware checks if the token's slug and the asset path share the same directory prefix
  - Actually, simplest correct approach: for share-token asset access, extract the token's slug from the token itself (decode without full HMAC verify first), check if the asset is in the same directory, then do full `verifyShare(token, tokenSlug)` to validate the token. This way we don't need to guess which page the asset belongs to.

Wait — `verifyShare` requires a `requestSlug` to match against the token's slug. For page access, requestSlug = page slug. For asset access, we need a different approach since the asset path doesn't match the page slug.

**Revised share-token asset approach**: Add a new function `verifyShareForAsset(token, assetSlug)` that:
1. Decodes the token to extract the token's page slug
2. Validates the token (HMAC, expiry, revocation) using the token's own slug (not the asset slug)
3. Checks that the asset is in the same directory as the token's page slug
4. Returns `{ valid, slug }` if all checks pass

This avoids modifying `verifyShare` and keeps the scope check clean.

## Development Checklist

- [ ] Add MIME type map and asset extension allowlist to `src/utils/mime.js` (new file)
- [ ] Add `resolveAssetPath(slug, contentRoot)` to `src/security/pathGuard.js`
  - Validates slug, extracts extension, checks allowlist
  - Resolves and verifies path within contentRoot
  - Returns `{ filePath, extension, mimeType }`
- [ ] Add `verifyShareForAsset(token, assetPath)` to `src/sharing/share-manager.js`
  - Decodes token, validates HMAC/expiry/revocation using token's own slug
  - Checks asset path shares same directory as token's slug
  - Returns `{ valid, slug }`
- [ ] Modify `src/security/auth.js` — add share-token bypass for asset paths
  - Detect asset extension in URL path
  - If `req.query.token` present and path is a recognized asset: call `verifyShareForAsset`
  - If valid: set viewerType='share', next()
  - If invalid: fall through to session check
- [ ] Modify `src/routes/pages.js` — add asset serving before page resolution
  - Check if slug has a recognized asset extension
  - If yes: resolve asset, read file, set headers, send
  - If no: proceed to existing page resolution
- [ ] Write tests

## Test Checklist

### Asset serving
- [ ] GET `/image.jpg` (authenticated) → 200 with correct Content-Type
- [ ] GET `/image.png` → correct MIME type
- [ ] GET `/style.css` → correct MIME type
- [ ] GET `/doc.pdf` → correct MIME type
- [ ] ETag returned, 304 on matching If-None-Match
- [ ] File over maxFileSizeBytes → 413
- [ ] Non-allowlisted extension → 404 (falls through to page route)

### Auth
- [ ] Unauthenticated GET asset → 302 redirect
- [ ] Session-authenticated GET asset → 200

### Share-token asset access
- [ ] Share token for `renovation-checklist`, GET `/kitchen-ref.jpg?token=...` → 200 (same directory)
- [ ] Share token for `docs/guide`, GET `/docs/diagram.png?token=...` → 200 (same directory)
- [ ] Share token for `renovation-checklist`, GET `/other-dir/secret.jpg?token=...` → 302 (different directory)

### Path security
- [ ] Path traversal attempt (`../../../etc/passwd.jpg`) → 400
- [ ] Null byte in path → 400

### No regression
- [ ] Markdown pages still render
- [ ] HTML artifacts still serve (with `__PAGES_BASE` injection)
- [ ] `.md` and `.html` extension redirects still work
- [ ] State API still works
- [ ] Share-token page access still works
- [ ] All existing tests pass

## Assumptions

- `readFile` on binary files returns a Buffer — guaranteed by Node.js `fs` API
- `generateEtag` works on Buffer content — needs verification (currently used on HTML strings)
- Content directory may contain non-page files (images, etc.) — guaranteed by how Howard uses it (renovation images)
- The existing `maxFileSizeBytes` config (default 1MB) is appropriate for images — reasonable for web-served assets

## Acceptance Checklist

- [ ] Place `kitchen-ref.jpg` in pages content directory
- [ ] Update `renovation-checklist.html` to use relative path `src="kitchen-ref.jpg"`
- [ ] Authenticated: image loads in page
- [ ] Share link: image loads via share token
- [ ] Unauthenticated without token: image returns login redirect
- [ ] `npm test` passes
- [ ] No regression on existing pages/API functionality
