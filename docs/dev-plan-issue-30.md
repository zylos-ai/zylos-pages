# Dev Plan: Server-side State API for HTML Artifacts (#30)

## Summary

Add a generic key-value state API to zylos-pages so HTML artifacts can persist interactive state (checkbox completion, etc.) server-side instead of relying on browser localStorage. Uses `pages.db` (better-sqlite3) via a new shared DB module, and follows the same patterns as `todo-api.js` and `share-api.js`.

## Scope

**In scope:**
- Shared DB module (`src/db/pages-db.js`) — singleton connection to `pages.db`
- Refactor `auth.js` to use shared DB module instead of private DB instance
- New SQLite table `artifact_state` in `pages.db`
- New REST API routes (`/api/state/:artifact`, `/api/state/:artifact/:key`)
- CSRF protection on mutating requests (same Origin/Referer pattern as todo-api)
- Input validation and size limits

**Out of scope:**
- Share viewer access to state API (Phase 1: authenticated-only; share viewers get 403 on all state endpoints)
- Migration of `renovation-checklist.html` (follow-up after API ships; artifact lives outside this repo)
- Versioning / history of state changes
- Real-time sync (WebSocket push)

## Contracts

### Artifact ID
- Allowed characters: `a-z`, `0-9`, `-` (lowercase alphanumeric + hyphens)
- No leading/trailing hyphens, no consecutive hyphens
- Max length: 100 chars
- Independent identifier chosen by the HTML artifact author — NOT a page slug mapping
- Regex: `/^[a-z0-9]+(-[a-z0-9]+)*$/`, length ≤ 100

### Key
- Allowed characters: `a-z`, `A-Z`, `0-9`, `-`, `_`, `.`
- Max length: 100 chars
- Empty string rejected
- Regex: `/^[a-zA-Z0-9._-]{1,100}$/`

### Value
- Any JSON-serializable value (boolean, number, string, null, object, array)
- Max size: 64KB of `JSON.stringify(value)` output
- `undefined` and functions are not valid JSON and will be rejected at parse level

### PUT body
- Shape: `{ "value": <any JSON value> }`
- Max raw body size: 64KB (enforced at body parser level)
- Missing `value` key → 400
- Body not valid JSON → 400

### Responses
- `GET /api/state/:artifact` → `{ "ok": true, "state": { key1: value1, key2: value2, ... } }`
- `GET /api/state/:artifact/:key` → `{ "ok": true, "key": "...", "value": ... }` or 404 if key not set
- `PUT /api/state/:artifact/:key` → `{ "ok": true, "key": "...", "value": ... }`
- `DELETE /api/state/:artifact/:key` → `{ "ok": true }` (idempotent, no error if key doesn't exist)

## Development Checklist

- [ ] Create `src/db/pages-db.js` — shared DB singleton
  - Opens `DATA_DIR/pages.db`, sets WAL mode
  - Exports `getPagesDb()` returning the singleton Database instance
  - Initializes on first call (lazy), safe to call multiple times
- [ ] Refactor `src/security/auth.js` — use shared DB module
  - Replace private `db` variable and `initSessionStore()` DB open with `getPagesDb()`
  - Keep session table creation in auth init (auth owns its schema)
  - All existing tests must still pass
- [ ] Create `src/state/state-store.js` — state storage layer
  - `initStateStore()` — CREATE TABLE IF NOT EXISTS `artifact_state`
  - `getArtifactState(artifact)` — return all key-value pairs as object
  - `getStateValue(artifact, key)` — return parsed value or null
  - `setStateValue(artifact, key, value)` — INSERT OR REPLACE, value stored as `JSON.stringify(value)`
  - `deleteStateValue(artifact, key)` — DELETE row
  - Called with validated inputs only (validation in route layer)
- [ ] Create `src/routes/state-api.js` — Express route handlers
  - `GET /api/state/:artifact` — all state for artifact
  - `GET /api/state/:artifact/:key` — single key
  - `PUT /api/state/:artifact/:key` — set value (CSRF required)
  - `DELETE /api/state/:artifact/:key` — remove key (CSRF required)
  - CSRF check on PUT/DELETE using same `csrfCheck` pattern as todo-api
  - GET does not require CSRF
  - All endpoints require authentication (share viewers get 403)
  - Validate artifact ID and key against contracts above
  - Parse body with size limit (reuse `parseJsonBody` pattern, 64KB cap)
- [ ] Wire up in `src/index.js`
  - Import and call `setupStateApi(app)`
  - Place after auth middleware, before catch-all page route
  - No config gate needed (always enabled when pages is running)

## Test Checklist

### State store unit tests
- [ ] `setStateValue` + `getStateValue` round-trip for: boolean, number, string, null, object, array
- [ ] `getArtifactState` returns all keys for artifact, empty object for unknown artifact
- [ ] `deleteStateValue` removes key; no error for non-existent key
- [ ] `setStateValue` overwrites existing key (upsert)
- [ ] Different artifacts have isolated namespaces

### API route tests
- [ ] GET `/api/state/test-artifact` returns `{ ok: true, state: {} }` for new artifact
- [ ] PUT `/api/state/test-artifact/key1` with `{ "value": true }` → 200, stores value
- [ ] GET `/api/state/test-artifact/key1` → returns `{ ok: true, key: "key1", value: true }`
- [ ] GET `/api/state/test-artifact` → returns all keys
- [ ] DELETE `/api/state/test-artifact/key1` → 200
- [ ] GET `/api/state/test-artifact/key1` → 404 after delete

### CSRF tests
- [ ] PUT with same-origin Origin header → 200
- [ ] PUT with cross-origin Origin header → 403
- [ ] PUT with same-host Referer (no Origin) → 200
- [ ] PUT/DELETE with no Origin and no Referer → 403
- [ ] GET without Origin/Referer → 200 (GET does not require CSRF)

### Auth tests
- [ ] Unauthenticated request to GET `/api/state/...` → redirect to login or 401
- [ ] Share token viewer request to state API → 403

### Validation tests
- [ ] Invalid artifact ID (uppercase, special chars, >100 chars) → 400
- [ ] Invalid key (special chars outside allowed set, empty, >100 chars) → 400
- [ ] Body >64KB → 413
- [ ] Body not valid JSON → 400
- [ ] Body missing `value` field → 400
- [ ] Null value accepted, stored, and retrievable

### Regression
- [ ] Existing todo-api tests pass
- [ ] Existing auth/session tests pass
- [ ] Page rendering unaffected

## Assumptions

- `better-sqlite3` singleton connection can be reused across modules within the same Node.js process — guaranteed by library design (synchronous, single-process). Not shared across worker threads (render worker doesn't use DB).
- CSP `connect-src 'self'` in `HTML_ARTIFACT_CSP` allows HTML artifacts to `fetch()` same-origin API endpoints — verified in `src/security/headers.js`.
- Auth middleware runs before state API routes — guaranteed by route registration order in `index.js`.

## Acceptance Checklist

- [ ] `GET /api/state/test-artifact` returns empty state for new artifact
- [ ] `PUT /api/state/test-artifact/key1` with `{ "value": true }` stores and returns the value
- [ ] `PUT /api/state/test-artifact/key2` with `{ "value": { "nested": [1,2,3] } }` stores complex types
- [ ] `GET /api/state/test-artifact` returns both keys
- [ ] `DELETE /api/state/test-artifact/key1` removes the key
- [ ] CSRF: PUT with cross-origin Origin → 403; PUT without Origin/Referer → 403; GET without headers → 200
- [ ] Unauthenticated fetch → redirect/401
- [ ] All existing tests pass (no regression)
- [ ] Server starts cleanly with auth enabled and disabled
