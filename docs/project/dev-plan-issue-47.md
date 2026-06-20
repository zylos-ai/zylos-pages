# Dev Plan: Add artifact attachment uploads for HTML checklist photo logs (#47)

## Summary

Build a Pages attachment API so HTML artifacts can upload, list, render, and delete image attachments that persist across devices. The first user-facing integration is the renovation checklist photo log for `拆除后现场拍照留档`.

## Mode

Complex feature. This adds a new backend surface for uploads, file storage, metadata persistence, permission checks, and deletion behavior.

## Scope

In scope:

- Store image attachments under the Pages data directory, separate from authored page content.
- Track attachment metadata in SQLite.
- Support authenticated upload, list, file read, and delete.
- Allow share viewers to list/read attachments when the share grants access to the matching artifact.
- Reject share viewer upload/delete for v1.
- Reject upload/delete when Pages auth is disabled unless a future explicit trusted-local attachment setting is added. State API permits unauthenticated CRUD in auth-disabled mode, but attachments are a disk-consuming upload surface and should not inherit that behavior by default.
- Allow uploads only for existing HTML/Markdown artifacts in v1. The API is not a general namespace allocator for arbitrary syntactically valid artifact IDs.
- Validate artifact IDs, item keys, attachment IDs, MIME type, extension, file size, and path traversal attempts.
- Update the renovation checklist HTML artifact so the photo-log item can upload images, show thumbnails, open a larger preview, and delete uploaded images for authenticated users.
- Add automated tests for the backend API and run browser verification for the checklist UI.

Out of scope for v1:

- Server-side thumbnail generation. Browser-scaled thumbnails are acceptable with conservative upload limits.
- Non-image attachments.
- Share viewer upload/delete.
- Bulk image editing, captions, tagging, or image compression.
- General Markdown syntax for attachments.

## Proposed Design

### Storage

- Add an attachment module under `src/attachments/`.
- Store files under `${DATA_DIR}/attachments/<artifact>/<attachmentId>.<ext>`.
- Parse uploads into `${DATA_DIR}/attachments/.tmp/` first. Do not expose or record the upload until validation passes and the final file path exists.
- Use random attachment IDs, not user-provided filenames, for stored paths.
- Keep original filenames only as metadata.
- Create the artifact directory lazily and remove the file when metadata is deleted.
- Upload operation order:
  1. Validate artifact/key and confirm the artifact exists in `config.contentDir` as `<artifact>.html` or `<artifact>.md`.
  2. Stream the multipart file into a temporary file while enforcing max size.
  3. Validate MIME allowlist and magic bytes from the temporary file.
  4. Generate `attachmentId` and move the temporary file to the final attachment path.
  5. Insert metadata in SQLite.
  6. If metadata insert fails, unlink the final file before returning an error.
  7. If any earlier step fails, unlink the temporary file before returning an error.
- Delete operation order:
  1. Look up metadata by artifact + attachment ID.
  2. Delete metadata in SQLite first so the file URL becomes inaccessible immediately.
  3. Unlink the stored file as a best-effort cleanup.
  4. Treat an already-missing file as successful cleanup and log it at warn/info level.
  5. Do not report success if metadata did not exist.

### Metadata

Create table `artifact_attachments` in `pages.db`:

```sql
CREATE TABLE IF NOT EXISTS artifact_attachments (
  attachment_id TEXT PRIMARY KEY,
  artifact TEXT NOT NULL,
  item_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_attachments_artifact_key_created
  ON artifact_attachments(artifact, item_key, created_at DESC);
```

### API

- `GET /api/attachments/:artifact/:key`
  - Authenticated users: list metadata.
  - Share viewers: allowed if the share access cookie or legacy token matches the artifact.
- `POST /api/attachments/:artifact/:key`
  - Authenticated users only.
  - Requires `res.locals.authenticated === true`; auth-disabled installs are rejected for mutation by default.
  - Accept a single multipart field named `file`.
  - Enforce image allowlist and size limit.
- `GET /api/attachments/:artifact/:attachmentId/file`
  - Authenticated users: allowed.
  - Share viewers: allowed if share scope matches the artifact.
  - Validate metadata artifact matches the URL artifact.
- `DELETE /api/attachments/:artifact/:attachmentId`
  - Authenticated users only.
  - Requires `res.locals.authenticated === true`; auth-disabled installs are rejected for mutation by default.
  - Delete metadata and stored file.

### Validation

- Reuse artifact/key validation compatible with `state-api.js`.
- Confirm artifact existence before upload by resolving `<artifact>.html` or `<artifact>.md` under `config.contentDir`. Listing/reading existing attachments may still work if the artifact is later removed, but new uploads must not create orphan namespaces.
- Attachment IDs are generated server-side and validated as fixed lowercase hex.
- Allow MIME types: `image/jpeg`, `image/png`, `image/webp`.
- Map MIME to extension server-side; never trust uploaded filename extension for storage.
- Use a conservative default upload limit in config, e.g. `attachments.maxFileSizeBytes = 5 * 1024 * 1024`.
- Reject files whose sniffed magic bytes do not match the declared MIME where practical.
- Apply same-host CSRF checks to `POST` and `DELETE`.
- Ensure resolved file paths stay inside the attachment root.

### Auth And Share Semantics

- Keep `setupAuth` as the central gate.
- Extend auth middleware to recognize `GET /api/attachments/:artifact/...` for valid share access cookies and legacy tokens.
- Do not allow share viewers to mutate attachments in v1, even though state API currently allows share writes.
- Attachment file URLs should not rely on the static asset route because files are outside the content directory and require artifact-aware permission checks.
- Revoked or expired shares must fail attachment list/read.

### Renovation Checklist Integration

- Add a compact photo upload block to the `拆除后现场拍照留档` item.
- On load, call `GET /api/attachments/renovation-checklist/<itemKey>` and render thumbnails.
- Authenticated view: show upload input and delete buttons.
- Share view: thumbnails should render; upload/delete controls should hide or fail cleanly.
- Clicking a thumbnail opens a lightweight full-size preview overlay.
- Preserve current checklist state behavior and progress calculation.

## Development Checklist

- [ ] Add attachment config defaults.
- [ ] Add SQLite attachment store and file storage helpers.
- [ ] Add multipart upload parsing without introducing broad body-parser side effects.
- [ ] Add attachment route module and wire it into `src/index.js` after auth.
- [ ] Extend auth middleware for share read access to attachment list/file routes.
- [ ] Add validation and error handling for invalid artifact/key/id, MIME, size, and path traversal cases.
- [ ] Add tests for authenticated upload/list/read/delete.
- [ ] Add tests for share read access.
- [ ] Add tests for share upload/delete rejection.
- [ ] Add tests for revoked/expired share rejection.
- [ ] Add tests for invalid MIME, oversized upload, and traversal-like inputs.
- [ ] Add tests for metadata insert failure cleanup and final file move/write failure leaving no durable metadata.
- [ ] Add tests for delete with a missing stored file and delete with missing metadata.
- [ ] Add tests that auth-disabled mode rejects upload/delete by default.
- [ ] Add tests that upload to a syntactically valid but nonexistent artifact is rejected.
- [ ] Update `renovation-checklist.html` to use the attachment API for the photo-log item.
- [ ] Run browser verification on desktop and mobile widths for upload, thumbnail, preview, refresh persistence, and delete.

## Test Checklist

- [ ] `npm test`
- [ ] Attachment API tests with auth enabled.
- [ ] Auth-disabled mode can list/read public attachment routes as applicable, but rejects upload/delete by default.
- [ ] Authenticated user can upload JPEG, PNG, and WebP.
- [ ] List response returns stable metadata and file URLs.
- [ ] File endpoint returns the image with correct content type and no-store cache headers.
- [ ] Delete removes metadata and makes the file endpoint return 404.
- [ ] Share viewer can list/read attachments for the matching artifact.
- [ ] Share viewer cannot upload or delete.
- [ ] Revoked, expired, malformed, or wrong-artifact shares cannot read attachments.
- [ ] Oversized payloads are rejected before writing permanent metadata.
- [ ] Rejected uploads leave no durable metadata and no referenced final file.
- [ ] Metadata insert failure after final file move unlinks the final file before returning an error.
- [ ] Final file write/move failure leaves no metadata.
- [ ] Delete succeeds when metadata exists but the file is already missing.
- [ ] Delete returns 404 when metadata does not exist.
- [ ] Unsupported MIME types are rejected.
- [ ] Path traversal values in artifact/key/attachment ID are rejected.
- [ ] Upload to a nonexistent artifact is rejected.
- [ ] Existing state API, share API, asset route, raw API, and HTML artifact tests still pass.

## Assumptions

- [ ] Artifact IDs use the existing state API format (`^[a-z0-9]+(-[a-z0-9]+)*$`) and `renovation-checklist` satisfies it. Guaranteed by current checklist slug and state API behavior.
- [ ] Item keys can reuse the existing state API key format (`^[a-zA-Z0-9._-]{1,100}$`). Needs validation in the route.
- [ ] Attachment IDs do not need ordering semantics. Guaranteed if list ordering uses `created_at DESC` and does not infer continuity from IDs.
- [ ] SQLite is the authoritative metadata store; files are blobs referenced by metadata. Upload uses compensating cleanup so failed inserts do not leave referenced files; delete removes metadata first and treats missing files as cleanup-success.
- [ ] File extension can be derived from validated MIME type. Guaranteed by the v1 image allowlist.
- [ ] Share read access should be artifact-scoped, not directory-scoped. Needs implementation in auth middleware because static asset share scope is directory-based.
- [ ] Share viewers are read-only for attachments in v1. Product decision from issue wording: upload/delete from share viewers is separate and likely disabled.
- [ ] Auth-disabled installs should not allow attachment mutation by default. This is a conservative security/product decision for v1 because uploads consume disk and create server-hosted content.
- [ ] New uploads require the target artifact to exist as an HTML or Markdown page in `config.contentDir`. This prevents arbitrary attachment namespaces; lifecycle cleanup for deleted artifacts is out of scope for v1.
- [ ] Browser-scaled thumbnails are acceptable for v1. Product decision from issue implementation notes.

## Acceptance Checklist

- [ ] A phone browser can upload at least one JPEG/PNG/WebP photo from the renovation checklist.
- [ ] Uploaded photos remain visible after refresh.
- [ ] Uploaded photos are visible from another logged-in browser session.
- [ ] A share viewer can see uploaded photos under the existing share-token/scope model.
- [ ] Share viewers cannot upload or delete photos.
- [ ] Authenticated users can delete a photo, and the deleted file is no longer accessible.
- [ ] Invalid MIME, oversized files, and traversal attempts are rejected.
- [ ] Existing Pages behavior still passes tests.
- [ ] Browser screenshots verify desktop and mobile checklist layout.
- [ ] No unreviewed dev plan document remains on main before merge.
