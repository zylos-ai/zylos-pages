# Issue #120 — Attachment page implementation inventory

## Contract

Add `attachment` as a third logical-page type for arbitrary allowed-root files.
It shares the existing page identity and share ledger while remaining
structurally outside every render or interactive-document path.

## Type consumers

| Consumer | Attachment behavior |
|---|---|
| Registration / descriptor / page service | Persist `page_type`; classify extension mismatches as attachment; descriptor returns stored type; `getPage` rejects before cache/singleflight/render. |
| Owner and share routes | Minimal landing page plus `/p/<uri>/download` and `/s/<token>/download`; exact registered URI wins over the `/download` suffix interpretation. |
| Navigation / list / search | Include the page and expose `type=attachment`. |
| Share create / list / info / revoke / expiry / password / tombstone | Reuse the existing stable `page_id` ledger unchanged. |
| Raw Markdown | Reject attachment. |
| State API | Reject attachment. |
| Embedded attachment API | Reject attachment; existing photo behavior and inline disposition are unchanged. |
| Logical and signed assets | Reject attachment as a page source. |
| Cache / watcher | No render cache entry; existing watcher continues to watch only Markdown/HTML sources. |
| CLI / hooks / config | CLI surfaces type; fresh install and both hooks provide `security.maxAttachmentSizeBytes` only when absent. |

## Download security

- Stream the registered real file; recheck the 50 MiB default ceiling.
- Use the existing MIME extension allowlist with
  `application/octet-stream` fallback.
- Always use `Content-Disposition: attachment`, `no-store`, `nosniff`,
  no-referrer, ETag, and Last-Modified.
- Apply the same share authorization to landing and download paths, including
  malformed/revoked/expired tokens, wrong-scope cookies, password challenges,
  header proofs, and unlock sessions.

## Acceptance scenarios

- Register and download a multi-MiB resume PDF through owner and share paths.
- Contract share transitions active → expired → inaccessible; revocation is
  independently inaccessible.
- SVG and HTML-like content never executes inline.
- Raw/state/embedded-attachment/logical-asset paths cannot reach file pages.
- Registration and download enforce the dedicated size ceiling.

Non-goals: preview, versions, upload API, or any behavior change to embedded
photo attachments.
