# External File Registration

## Current contract

Pages exposes local files only after an explicit logical-page registration.
The canonical source stays in its owning component or content directory; Pages
stores its real path and stable `page_id` in `pages.db` and never copies,
symlinks, uploads, or deletes the source.

Registration accepts an absolute path to a regular file only when its
symlink-resolved path is inside `contentDir` or a configured
`externalFiles.allowedSources` / `sourceRegistry.allowedSources` root.

The stored `type` is determined once at registration:

- requested and real extensions both `.md` → `markdown`
- requested and real extensions both `.html` → `html`
- every other file or extension mismatch → `attachment`

The mismatch rule prevents a `.md` symlink to HTML (or the inverse) from
crossing into a renderer under a misleading path.

## Attachment pages

An attachment is a logical page in navigation, search, list, share, rename,
unregister, expiry, revocation, password, and tombstone ledgers. It is not a
renderable document.

- owner landing page: `/pages/p/<uri>`
- owner download: `/pages/p/<uri>/download`
- share landing page: `/pages/s/<tokenId>`
- share download: `/pages/s/<tokenId>/download`

Downloads are streaming responses with `Cache-Control: no-store`, ETag and
Last-Modified metadata, an extension-whitelist MIME type (or
`application/octet-stream`), `X-Content-Type-Options: nosniff`, and an
unconditional attachment disposition. HTML- or SVG-like bytes are never served
inline by this path.

`security.maxAttachmentSizeBytes` is a dedicated ceiling (50 MiB by default),
checked at registration and again before each download. It does not change the
existing `security.maxFileSizeBytes` render ceiling.

Attachment pages are explicitly rejected by `getPage`/render/cache, raw
Markdown, state, embedded-photo attachment, and logical/signed asset paths.
There is no preview, version management, or upload API.

## Lifecycle

Re-registering a URI updates its source/type while preserving its stable
`page_id`. Shares therefore follow the same logical page across source changes
and renames. Unregistering removes the page and browser sessions but retains
share rows as audit tombstones; it never deletes the source file.

Use `src/cli/pages.js register`, `list`, `share`, `shares`, `share-info`,
`unshare`, and `unregister`; see `references/pages-cli.md` for exact commands
and secret-handling rules.
