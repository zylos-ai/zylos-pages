# Dev Plan: Add Editable Share Mode for Artifact Attachments (#49)

## Summary

Add an explicit editable share mode so passwordless share viewers can upload and delete attachments for the shared artifact only. Existing share links remain read-only by default.

## Scope

- In scope: DB-backed share permission flag, share creation/list API fields, short-link and legacy token permission propagation, attachment upload/delete authorization for matching editable shares, and frontend controls that stay hidden for attachment-read-only shares but appear for editable shares.
- Out of scope: letting share viewers create or revoke shares, changing the existing state API share-write behavior, adding TODO/raw API mutations, upload to other artifacts, manage authentication, or bypass existing CSRF/file validation.

## Development Checklist

- [ ] Add a durable share permission field such as `can_write_attachments INTEGER NOT NULL DEFAULT 0` to `shares`.
- [ ] Update legacy/imported/existing shares so they default to read-only.
- [ ] Let `createShare` accept an explicit editable option and persist it.
- [ ] Include editable status in share create/list responses.
- [ ] Propagate editable status through `getActiveShare`, short share access sessions, legacy `verifyShare`, and `verifyShareAccessCookie`.
- [ ] Store request-local share attachment permissions in auth middleware without marking the viewer as authenticated.
- [ ] Allow attachment POST/DELETE when the request has a valid editable share for the same artifact.
- [ ] Do not grant any new non-attachment write capability to share viewers.
- [ ] Inject a frontend-readable editable-share flag into rendered pages/HTML artifacts.
- [ ] Update `assets/attachments.js` so share views are read-only unless the editable-share flag is true.
- [ ] Expose a share-modal control for creating an editable share link without changing the default read-only link behavior.

## Test Checklist

- [ ] Migration/default test: old shares and imported shares are read-only.
- [ ] Share API test: default create returns read-only; explicit editable create returns editable status; list includes editable status.
- [ ] Auth test: editable short-link cookie carries attachment write permission for the matching artifact.
- [ ] Auth test: editable legacy `?token=` carries attachment write permission for the matching artifact.
- [ ] Attachment API test: read-only share cannot upload/delete; editable share can upload/delete the matching artifact.
- [ ] Attachment API test: editable share cannot upload/delete another artifact.
- [ ] Attachment API test: revoked/expired editable shares cannot mutate.
- [ ] Attachment API test: cover both short-link cookie and legacy `?token=` mutation paths for read-only, editable, wrong-artifact, revoked, and expired cases.
- [ ] Frontend/unit or browser test: read-only share hides attachment controls; editable share shows upload/delete controls.
- [ ] Regression: authenticated users can still upload/delete; auth-disabled anonymous users remain blocked.

## Assumptions

- [ ] Share rows are authoritative for permissions; sessions must re-read joined share state so revoked/expired/permission changes take effect. Guaranteed by current `verifyShareAccessCookie` join against `shares`.
- [ ] The attachment API artifact parameter identifies the full mutation boundary. Guaranteed by `assertValidArtifactId` plus existing artifact existence checks.
- [ ] Existing share links must not become writable after migration. Requires DB default `0` and import path defaulting to `0`.
- [ ] CSRF protection remains required for share-based upload/delete because browsers can submit same-origin requests once a share cookie exists. Guaranteed by keeping current `csrfCheck`.
- [ ] Legacy `?token=` links may carry editable permission only if their DB share row was explicitly created editable. Requires `verifyShare` to return the persisted flag, with mutation tests separate from short-link cookie tests.

## Acceptance Checklist

- [ ] Existing attachment-read-only share links still show attachment thumbnails but no upload/delete controls.
- [ ] New editable share links allow passwordless upload, refresh replay, preview, and delete for `renovation-checklist` attachments.
- [ ] Editable share links cannot mutate another artifact's attachments.
- [ ] Share viewers still cannot create/revoke shares or gain new non-attachment write capabilities.
- [ ] Browser mobile screenshot verification completed for read-only and editable share states.
- [ ] `node --test test/share-api.test.js test/attachment-api.test.js` passes.
- [ ] `npm test` passes.
- [ ] `git diff --check origin/main...HEAD` passes.
