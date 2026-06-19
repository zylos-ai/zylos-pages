# Dev Plan: Share-token Access to State API (#32)

## Summary

Extend the share-token authentication bypass to cover `/api/state/*` routes, so HTML artifacts opened via share links can read and write their own state server-side. A share token scoped to slug `renovation-checklist` can only access `/api/state/renovation-checklist/*` — no other artifacts.

## Scope

**In scope:**
- Auth middleware: extend share-token bypass to `/api/state/*` paths (all HTTP methods)
- State API routes: scope enforcement (share token's slug must match artifact ID)
- HTML artifact convention: artifact ID = page slug (required for share-token validation)
- Client-side token forwarding: HTML artifacts extract `?token=` from page URL and include in API calls

**Out of scope:**
- Changing share token format or storage
- Share-token access to other API routes (todo-api, raw-api, share-api)
- Migration of renovation-checklist.html (separate follow-up after both #30 and #32 ship)

## Contracts

### Token forwarding
- HTML artifact JavaScript reads `token` from `window.location.search`
- API calls include `?token=<value>` as query parameter (same pattern as page access)
- If no token and no session → normal auth wall (302/401)

### Scope enforcement
- Share token's slug (embedded in HMAC payload) must equal the artifact ID in the URL path
- `verifyShare(token, artifactId)` is the validation — reuses existing HMAC + expiry + revocation checks
- Mismatch → 403 `{ error: "Token scope mismatch" }`

### Auth middleware changes
- New block for paths matching `/api/state/` prefix when `req.query.token` is present
- All HTTP methods allowed (GET, PUT, DELETE) — not limited to GET/HEAD like page share bypass
- Sets `res.locals.viewerType = 'share'` and `res.locals.shareSlug = <verified slug>`
- Existing page share bypass (GET/HEAD non-`/api/`) unchanged
- Existing session auth path unchanged

### State API route changes
- If `res.locals.viewerType === 'share'`: enforce `res.locals.shareSlug === req.params.artifact`, else 403
- CSRF still required on PUT/DELETE for share-token requests (token proves identity, CSRF proves intent)
- GET does not require CSRF (unchanged)

## Development Checklist

- [ ] Modify `src/security/auth.js` — add share-token bypass for `/api/state/*`
  - After existing page share bypass block (line ~468-482), add new block:
  - Condition: `req.query.token && req.path.startsWith('/api/state/')`
  - Extract artifact from path: split on `/`, take segment at index 3
  - Call `verifyShare(req.query.token, artifact)`
  - If valid: set `res.locals.viewerType = 'share'`, `res.locals.shareSlug = result.slug`, `next()`
  - If invalid: fall through to session check (same as current behavior)
- [ ] Modify `src/routes/state-api.js` — add scope enforcement
  - Add helper `rejectScopeMismatch(req, res)`: if `viewerType === 'share'` and `shareSlug !== req.params.artifact`, return 403
  - Call in all 4 route handlers (GET all, GET key, PUT, DELETE) after param validation
- [ ] Write tests in `test/state-api.test.js`

## Test Checklist

### Share-token state access
- [ ] Share token for artifact X can GET `/api/state/X` → 200
- [ ] Share token for artifact X can GET `/api/state/X/key` → 200
- [ ] Share token for artifact X can PUT `/api/state/X/key` with same-origin CSRF → 200
- [ ] Share token for artifact X can DELETE `/api/state/X/key` with same-origin CSRF → 200

### Scope enforcement
- [ ] Share token for artifact X accessing `/api/state/Y` → 403 scope mismatch
- [ ] Share token for artifact X accessing `/api/state/Y/key` → 403 scope mismatch

### CSRF still enforced for share tokens
- [ ] Share token PUT without Origin/Referer → 403 CSRF
- [ ] Share token DELETE without Origin/Referer → 403 CSRF

### Invalid share tokens
- [ ] Expired share token → falls through to auth wall (302 redirect)
- [ ] Revoked share token → falls through to auth wall (302 redirect)
- [ ] Malformed token → falls through to auth wall (302 redirect)

### No regression
- [ ] Authenticated user (session) state API still works (no token needed)
- [ ] Page share bypass (GET page with token) still works
- [ ] Share token does NOT grant access to other APIs (todo, raw, share)
- [ ] All existing tests pass

## Assumptions

- Artifact IDs equal page slugs for HTML artifacts — guaranteed by authoring convention (the HTML `fetch()` calls use the same ID as the page slug). `verifyShare()` uses `normalizeSlug()` on both sides, so flat artifact IDs (a-z0-9 + hyphens) are unaffected.
- `verifyShare()` is safe to call with artifact IDs (not just page paths) — guaranteed because it only normalizes and HMAC-verifies the string; it doesn't check file existence.
- Share tokens encode the slug in the HMAC payload — guaranteed by `share-manager.js` implementation.

## Acceptance Checklist

- [ ] Create a share link for `renovation-checklist` page
- [ ] Open share link in incognito browser (no session)
- [ ] Page loads correctly via share token
- [ ] JavaScript `fetch('/api/state/renovation-checklist?token=...')` returns state (not 302)
- [ ] PUT with share token + CSRF stores value
- [ ] Same token accessing `/api/state/other-artifact?token=...` returns 403
- [ ] Authenticated user state API works without token (no regression)
- [ ] All existing tests pass
