# Dev Plan: Share-token Access to State API (#32)

## Summary

Extend the share-token authentication bypass to cover `/api/state/*` routes, so HTML artifacts opened via share links can read and write their own state server-side. A share token scoped to slug `renovation-checklist` can only access `/api/state/renovation-checklist/*` — no other artifacts.

## Scope

**In scope:**
- Auth middleware: extend share-token bypass to `/api/state/*` paths (all HTTP methods)
- Client-side token forwarding: HTML artifacts extract `?token=` from page URL and include in API calls

**Out of scope:**
- Changing share token format or storage
- Share-token access to other API routes (todo-api, raw-api, share-api)
- Migration of renovation-checklist.html (separate follow-up after both #30 and #32 ship)
- Explicit artifact-to-slug mapping mechanism (Phase 2 only supports artifact ID = page slug; see Constraints)

## Constraints

**Artifact ID must equal page slug** — This is a deliberate product constraint for Phase 2, not a guaranteed system property. Issue #30's State API allows arbitrary artifact IDs, but share-token access only works when the artifact ID in the `fetch()` call matches the page slug embedded in the share token. HTML artifact authors must use the page slug as their artifact ID for share-token state access to work. This constraint is enforced by `verifyShare(token, artifactId)` — if the artifact ID doesn't match the token's slug, the token is simply invalid for that request.

## Contracts

### Token forwarding
- HTML artifact JavaScript reads `token` from `window.location.search`
- API calls include `?token=<value>` as query parameter (same pattern as page access)
- If no token and no session → normal auth wall (302 redirect)

### Scope enforcement
- Scope enforcement is handled entirely by `verifyShare(token, artifactId)` in the auth middleware
- `verifyShare` compares the token's embedded slug against the artifact ID from the URL path
- If the token's slug doesn't match the artifact ID → `verifyShare` returns `{ valid: false }` → request falls through to session check → 302 redirect (same as expired/revoked/malformed tokens)
- No separate route-level scope check needed — the auth middleware boundary is sufficient
- This means: token for artifact X accessing `/api/state/Y` gets 302 (not 403). The token is simply not valid for that artifact.

### Auth middleware changes
- New block for paths matching `/api/state/` prefix when `req.query.token` is present
- All HTTP methods allowed (GET, PUT, DELETE) — not limited to GET/HEAD like page share bypass
- Extract artifact ID from path: split on `/`, take segment at index 3
- Call `verifyShare(req.query.token, artifactId)` — reuses existing HMAC + expiry + revocation + slug match checks
- If valid: set `res.locals.viewerType = 'share'`, `res.locals.authenticated = false`, set no-store/no-referrer headers, `next()`
- If invalid: fall through to session check (same as current behavior — no special error)
- Existing page share bypass (GET/HEAD non-`/api/`) unchanged
- Existing session auth path unchanged
- Order: existing page share bypass → **new state API share bypass** → session check → 302

### State API route changes
- No route-level scope enforcement needed (auth middleware handles it)
- CSRF still required on PUT/DELETE for share-token requests (token proves identity, CSRF proves intent)
- GET does not require CSRF (unchanged)
- Check order in PUT/DELETE handlers: CSRF → param validation → body parse → store operation (unchanged from Phase 1)

## Development Checklist

- [ ] Modify `src/security/auth.js` — add share-token bypass for `/api/state/*`
  - After existing page share bypass block (line ~468-482), before session check (line ~484):
  - Condition: `req.query.token && req.path.startsWith('/api/state/')`
  - Extract artifact from URL path segments
  - Call `verifyShare(req.query.token, artifact)`
  - If valid: set `res.locals.viewerType = 'share'`, `res.locals.authenticated = false`, no-store, no-referrer, `next()`
  - If invalid: log and fall through (same pattern as existing page share block)
- [ ] Write tests in `test/state-api.test.js`

## Test Checklist

### Share-token state access (full integration: token → auth middleware → route → store)
- [ ] Share token for artifact X: GET `/api/state/X?token=...` → 200 with state
- [ ] Share token for artifact X: GET `/api/state/X/key?token=...` → 200 with value (after PUT)
- [ ] Share token for artifact X: PUT `/api/state/X/key?token=...` with same-origin CSRF → 200, stores value
- [ ] Share token for artifact X: DELETE `/api/state/X/key?token=...` with same-origin CSRF → 200

### Scope enforcement (mismatch = auth wall, not 403)
- [ ] Share token for artifact X: GET `/api/state/Y?token=...` → 302 redirect to login
- [ ] Share token for artifact X: PUT `/api/state/Y/key?token=...` → 302 redirect to login

### CSRF still enforced for share tokens
- [ ] Share token PUT without Origin/Referer → 403 CSRF (token gets through auth, but CSRF blocks)
- [ ] Share token DELETE without Origin/Referer → 403 CSRF

### Invalid share tokens on state API
- [ ] Expired share token on `/api/state/X?token=...` → 302 redirect
- [ ] Revoked share token on `/api/state/X?token=...` → 302 redirect
- [ ] Malformed/missing token on `/api/state/X` → 302 redirect

### No regression
- [ ] Authenticated user (session) state API still works without token
- [ ] Page share bypass (GET page with `?token=`) still works
- [ ] Share token on `/api/raw/...?token=...` still returns 302 (existing behavior preserved)
- [ ] Share token on `/api/todo/...?token=...` still returns 302 (not bypassed)
- [ ] All existing tests pass (63/63)

## Assumptions

- `verifyShare(token, artifactId)` is safe to call with artifact IDs (not just page paths) — verified: it only calls `normalizeSlug()` and does HMAC comparison; it doesn't check file existence or require the string to be a real page path.
- Share tokens encode the slug in the HMAC payload — verified in `src/sharing/share-manager.js:79-81`.
- `normalizeSlug()` is a no-op on valid artifact IDs (a-z0-9 + hyphens) — verified: it lowercases and strips leading/trailing slashes, which doesn't affect flat IDs.

## Acceptance Checklist

- [ ] Create a share link for a test page (e.g. `renovation-checklist`)
- [ ] In incognito browser (no session), open the share link — page loads
- [ ] From browser console: `fetch('/api/state/renovation-checklist?token=<token>')` → 200 with state (not 302)
- [ ] From browser console: PUT with token + Origin header → 200, stores value
- [ ] From browser console: `fetch('/api/state/other-artifact?token=<token>')` → 302 redirect (scope mismatch)
- [ ] Authenticated user state API works without token (no regression)
- [ ] `npm test` — all tests pass
