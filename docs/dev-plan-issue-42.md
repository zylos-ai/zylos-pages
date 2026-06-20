# Dev Plan: Move Sharing Fully To Short-Link Native Access (#42)

## Summary
Make `/s/<tokenId>` the native share entry point. Share records move to SQLite, valid short-link visits create an opaque share access session, and public/API/UI paths stop exposing long HMAC token URLs.

## Scope
- In scope: DB-backed share records, legacy `shares.json` import, share access sessions, short-link redirects to clean page URLs, page/raw/state/static-asset access via share cookies, removal of `longUrl` from create-share responses, and tests for revoked/expired/disabled sharing behavior.
- Out of scope: deleting the legacy `shares.json` file from disk, changing authenticated admin session storage, and removing legacy `?token=` compatibility if keeping it is low-cost and non-exposed.

## Development Checklist
- [x] Add `shares` and `share_sessions` tables to `pages.db`.
- [x] Import legacy `shares.json` records into `shares` once without continuing to write JSON.
- [x] Refactor share creation/list/revoke/cleanup to use SQLite.
- [x] Add opaque share access session creation and validation.
- [x] Change `/s/:tokenId` to validate the DB share, set share access/scope cookies, and redirect to clean `/<slug>`.
- [x] Update auth middleware so share access sessions authorize matching page/raw HTML/state API access.
- [x] Keep asset authorization scoped to the shared page directory and invalidated by revoke/expiry.
- [x] Remove generated/exposed long share URL fields from API responses.
- [x] Remove token propagation from HTML artifact iframe URLs.

## Test Checklist
- [x] Share creation response has `url`/`shortUrl` only and no `longUrl`.
- [x] Valid `/s/<tokenId>` redirects to clean page URL, sets cookies, and does not expose `?token=`.
- [x] HTML artifact wrapper and raw iframe load through short share access.
- [x] State API reads and writes work through short share access while still enforcing CSRF for writes.
- [x] Static assets work through share scope without accepting direct `?token=` asset access.
- [x] Revoked, expired, missing, and malformed tokenIds fail.
- [x] `sharing.enabled=false` keeps unauthenticated `/s/<32hex>` behind the login wall.
- [x] Legacy `shares.json` records import into DB.

## Assumptions
- [x] `tokenId` remains a 32-character lowercase hex value; guaranteed by the existing token generator and enforced at route/auth boundaries.
- [x] Share lookup is server-stateful under the new product decision; guaranteed by Howard's decision to move sharing to DB.
- [x] SQLite is sufficient for Pages personal-document concurrency; guaranteed by product scope, not a general multi-user assumption.
- [x] Keeping old `?token=` verification is acceptable only as hidden legacy compatibility; it must not be returned by API/UI or required by short-link flows.
- [x] Share access sessions may be revoked indirectly by checking the current share record on every validation.

## Acceptance Checklist
- [x] Issue #42 expected behavior is met.
- [x] Existing Issue #40 short-link default behavior remains met.
- [x] No long HMAC token appears in share create responses, short-link redirects, or HTML iframe src.
- [x] No regression in login/session auth, raw API blocking for share viewers, and asset 403 behavior.
- [x] Focused tests pass.
- [x] Full `npm test` passes.
