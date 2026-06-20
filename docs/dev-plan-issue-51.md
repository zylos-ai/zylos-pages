# Dev Plan: Allow Changing Editable Permission on Existing Share Links (#51)

## Summary
Add a way for authenticated users to toggle an existing share link between attachment-read-only and attachment-editable without regenerating the URL. This is a follow-up to Issue #49: ordinary shares stay read-only by default, but already-shared links can be upgraded or downgraded from the share management UI.

## Scope
- In scope:
  - Add an authenticated API path to update `can_write_attachments` for an existing active share.
  - Keep the existing `/s/<tokenId>` URL stable.
  - Reflect the updated permission in both newly created share sessions and existing share sessions.
  - Add a visible control in the Active shares list for toggling photo upload/delete.
  - Preserve the current security boundary: editable share grants only matching-artifact attachment POST/DELETE.
- Out of scope:
  - Changing share expiry/duration after creation.
  - Granting share viewers access to raw Markdown, share management, todo APIs, or non-attachment writes.
  - Creating role-based share permissions beyond the single photo upload/delete permission bit.

## Development Checklist
- [ ] Add a share-manager helper that updates `can_write_attachments` by `tokenId` only when the share exists and is not revoked/expired.
- [ ] Add a `PATCH /api/share/:tokenId` route accepting `{ "canWriteAttachments": boolean }`.
- [ ] Reuse existing CSRF and share-viewer rejection behavior from create/revoke routes.
- [ ] Return the updated share metadata from the PATCH response.
- [ ] Update `assets/share.js` to render each active share with a checkbox or compact toggle for "Allow photo upload/delete".
- [ ] Make the UI optimistic only after the PATCH response succeeds; on failure, reload or restore the previous checked state.
- [ ] Keep the existing revoke and revoke-all behavior unchanged.
- [ ] Ensure generated links and listed links continue to show current permission state.

## Test Checklist
- [ ] Unit/API test: PATCH can upgrade an existing read-only share to editable and list reflects the new value.
- [ ] Unit/API test: PATCH can downgrade an editable share to read-only and list reflects the new value.
- [ ] Unit/API test: share viewers cannot PATCH share permissions.
- [ ] Unit/API test: revoked, expired, malformed, or unknown token IDs cannot be updated.
- [ ] Attachment integration test: an existing share session created while read-only becomes able to upload after the authenticated toggle upgrades it.
- [ ] Attachment integration test: an existing share session created while editable loses upload/delete permission after the authenticated toggle downgrades it.
- [ ] Legacy-token integration test: create a read-only share, keep its existing legacy `?token=`, PATCH it editable, then matching-artifact POST/DELETE with that same token succeeds.
- [ ] Legacy-token integration test: create an editable share, keep its existing legacy `?token=`, PATCH it read-only, then matching-artifact POST/DELETE with that same token is blocked.
- [ ] Legacy-token integration test: wrong-artifact attachment mutation remains blocked after both upgrade and downgrade directions.
- [ ] Frontend/manual test: Active shares list shows the toggle and preserves the same URL after permission changes.
- [ ] Full `npm test`.

## Assumptions
- [ ] `token_id` is globally unique in the `shares` table. Guaranteed by the primary key.
- [ ] Existing share sessions read current permission through the `shares` join, not a copied permission value. Guaranteed by `verifyShareAccessCookie()` joining `share_sessions` to `shares`.
- [ ] Updating `can_write_attachments` in `shares` is enough for legacy `?token=` verification too. Guaranteed by `verifyShare()` calling `activeShareRecord()`.
- [ ] Only authenticated users reach share-management routes. Enforced by auth middleware plus explicit `viewerType === 'share'` rejection in route handlers.
- [ ] URL stability is preserved because the short URL uses `tokenId`, and this feature does not mutate `token_id`, `slug`, or `expires_at`.

## Acceptance Checklist
- [ ] Existing read-only share URL remains the same after upgrade and can upload/delete photos for its artifact.
- [ ] Existing editable share URL remains the same after downgrade and can no longer upload/delete photos.
- [ ] Existing legacy long token reflects the toggled permission without generating a new token.
- [ ] Ordinary shares still default to read-only unless the create checkbox is checked.
- [ ] Editable shares still cannot mutate a different artifact.
- [ ] Share viewers cannot see or use share-management controls.
- [ ] Browser screenshot: Active shares list shows the permission toggle in desktop and mobile widths.
- [ ] Full test suite passes.
- [ ] Dev plan is removed before merge.
