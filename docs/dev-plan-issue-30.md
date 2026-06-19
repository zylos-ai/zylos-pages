# Dev Plan: Server-side State API for HTML Artifacts (#30)

## Summary

Add a generic key-value state API to zylos-pages so HTML artifacts can persist interactive state (checkbox completion, etc.) server-side instead of relying on browser localStorage. Reuses existing `pages.db` (better-sqlite3) and follows the same patterns as `todo-api.js` and `share-api.js`.

## Scope

**In scope:**
- New SQLite table `artifact_state` in `pages.db`
- New REST API routes (`/api/state/:artifact`, `/api/state/:artifact/:key`)
- CSRF protection (same Origin/Referer pattern as todo-api)
- Input validation and size limits
- Migrate `renovation-checklist.html` to use server-side API with localStorage fallback

**Out of scope:**
- Authentication per artifact (uses existing session auth)
- Versioning / history of state changes
- Real-time sync (WebSocket push)

## Development Checklist

- [ ] Create `src/state/state-store.js` — SQLite table init + CRUD functions
  - `initStateStore(db)` — CREATE TABLE IF NOT EXISTS
  - `getArtifactState(artifact)` — return all keys for artifact
  - `getStateValue(artifact, key)` — return single key
  - `setStateValue(artifact, key, value)` — upsert key (value is JSON-encoded)
  - `deleteStateValue(artifact, key)` — remove key
- [ ] Create `src/routes/state-api.js` — Express route handlers
  - `GET /api/state/:artifact` — list all state for artifact
  - `GET /api/state/:artifact/:key` — get single key value
  - `PUT /api/state/:artifact/:key` — set key value (body: `{ value: any }`)
  - `DELETE /api/state/:artifact/:key` — remove key
  - CSRF check on PUT/DELETE (reuse pattern from todo-api)
  - Share viewers cannot write (read-only)
  - Input validation: artifact name alphanumeric + hyphens, key max 100 chars, value JSON max 64KB
- [ ] Wire up in `src/index.js` — register state API routes (after auth, before catch-all)
  - Pass the existing `pages.db` Database instance from auth module
- [ ] Export db instance from auth.js (or create shared db module) so state-store can reuse it
- [ ] Migrate `renovation-checklist.html`:
  - On load: fetch server state, merge with localStorage (server wins)
  - On checkbox toggle: write to server, update localStorage as fallback
  - Graceful degradation: if server unreachable, fall back to localStorage only

## Test Checklist

- [ ] State store unit tests: CRUD operations, JSON encoding of various types (boolean, number, string, object, array, null)
- [ ] API route tests: valid requests return correct data, CSRF rejection, invalid input rejection
- [ ] Integration: renovation-checklist checkbox persists across browser clear
- [ ] Edge cases: very long value (>64KB rejected), empty artifact name, special chars in key
- [ ] No regression: existing todo-api and share-api still work

## Assumptions

- `pages.db` is already initialized by `auth.js` on startup — **guaranteed** (auth runs before route setup)
- `better-sqlite3` Database instance can be shared across modules — **guaranteed** (it's thread-safe for same-process use)
- HTML artifacts can make `fetch()` calls to same-origin `/api/state/` — **guaranteed** (CSP `connect-src 'self'` is set in `HTML_ARTIFACT_CSP`)
- Artifact names map 1:1 to page slugs — **assumption, validated by convention** (e.g. `renovation-checklist`)

## Acceptance Checklist

- [ ] `GET /api/state/test-artifact` returns empty state for new artifact
- [ ] `PUT /api/state/test-artifact/key1` with `{ "value": true }` stores and returns the value
- [ ] `PUT /api/state/test-artifact/key2` with `{ "value": { "nested": [1,2,3] } }` stores complex types
- [ ] `GET /api/state/test-artifact` returns both keys
- [ ] `DELETE /api/state/test-artifact/key1` removes the key
- [ ] CSRF: request without Origin/Referer header is rejected on PUT/DELETE
- [ ] renovation-checklist.html: check a box, clear localStorage, reload — checkbox still checked
- [ ] renovation-checklist.html: check a box on one device, open on another — state synced
- [ ] No regressions in existing pages rendering, todo boards, share links
