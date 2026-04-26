# External File Registration

## Purpose

zylos-pages should support rendering Markdown documents whose source of truth
lives in another Zylos component's data directory, without requiring that
component to copy documents into the pages content directory or reimplement a
Markdown viewer.

The first planned consumer is zylos-recruit, which will generate reference
interview-question documents and expose them through pages when pages is
installed.

## Design Logic

Pages remains the owner of the viewer domain. It controls which files are made
available under `/pages/*`, how those files are rendered, and which users may
view them through pages authentication.

The source component remains the owner of the document content. For recruit,
the canonical Markdown file stays under the recruit data directory. When the
document is changed by recruit, pages should render the latest file content on
the next request.

The integration contract is file-level registration:

- A component asks pages to register a Markdown file.
- Pages validates that the file is an allowed source file.
- Pages creates and manages a symlink under its configured content directory.
- Pages returns the viewer slug or URL for the registered document.
- Pages may record a thin registry entry for lifecycle management, but this
  registry does not carry component-specific business metadata.

This keeps the boundary simple:

- Recruit owns interview-question content and candidate/role semantics.
- Pages owns presentation, page routing, pages authentication, and symlink
  registration.
- The symlink is a local integration artifact, not a cross-component business
  database.

## Permissions Model

Viewing a registered document happens inside the pages domain. Once a document
is registered with pages, access to the rendered document is governed by pages
authentication and sharing rules.

Registration is a privileged local operation. Pages must not allow arbitrary
files on the host to be exposed through symlinks. A registered source file must
be constrained to an allowed component data directory and must resolve to a
Markdown file.

## Registry Scope

Pages may maintain a registry such as `external-files.json` to track:

- viewer slug
- owner component
- canonical source path
- symlink path
- creation and update timestamps

The registry should not store recruit-specific concepts such as candidate,
role, evaluation, verdict, or interview status. Those belong in recruit.

## Registry Maintenance and Concurrency

`external-files.json` should be owned and written only by the pages
registration surface. External components such as recruit should never edit the
registry directly.

Registry updates should be serialized with a local lock. A simple filesystem
lock is sufficient for the first version because registration happens on the
same host as pages. For example, pages can acquire a lock by creating an
`external-files.lock` directory atomically, retry briefly when the lock already
exists, and include diagnostic owner information such as process id and
timestamp in the lock directory.

While holding the lock, registration should:

- read the latest registry file
- validate the requested slug and source path
- create or update the pages-managed symlink
- update the in-memory registry object
- write the registry to a temporary file
- atomically rename the temporary file to `external-files.json`
- release the lock

This makes concurrent registrations safe. Multiple recruit workers may generate
documents at the same time, but their pages registration operations are queued
through the pages lock. Each operation reads the latest registry state before
writing, so concurrent writes do not lose each other's updates.

Registration should be idempotent where possible:

- same slug and same source path: succeed and refresh registry metadata
- same slug and different source path: reject unless replacement is explicitly
  requested
- slug points to a normal pages document: reject
- source path no longer exists or escapes the allowed source root: reject

Unregistration should use the same lock. It should remove only pages-managed
symlinks that are recorded in the registry, update the registry with an atomic
write, and never delete the source Markdown file owned by the external
component.

If a registration fails after creating a symlink but before the registry write
completes, pages should attempt to roll back the symlink. If a process exits
after the atomic registry write succeeds, the registry remains authoritative and
the next operation can continue from that state.

## Expected zylos-pages Changes

Pages should add a small external-file registration surface. A local CLI is
preferred for the first version because pages and recruit run on the same host
and do not need service-to-service HTTP authentication.

The registration surface should support:

- register a Markdown source file under a requested pages slug
- unregister a previously registered external file
- report whether external-file registration is available
- reject sources outside allowed component directories
- reject non-Markdown files
- avoid overwriting pages-owned files or another component's registered file
- maintain a thin registry for cleanup, conflict detection, and diagnostics

The existing Markdown render path should remain responsible for rendering
registered files. It should not need to understand recruit.

## Acceptance Criteria

- A Markdown file stored under an allowed external component data directory can
  be registered and opened through `/pages/<slug>`.
- The registered pages URL is protected by pages authentication in the same way
  as normal pages documents.
- Updating the source Markdown file in the owning component is reflected by
  pages on the next request without copying the file.
- Registration rejects paths that escape the allowed component source root after
  resolving symlinks.
- Registration rejects non-`.md` files and missing files.
- Registration cannot overwrite an existing normal pages document.
- Registration records enough information for pages to unregister or diagnose a
  registered external document.
- Concurrent registration requests are serialized so that registry updates are
  not lost.
- Unregistering removes the pages-managed symlink and registry entry without
  deleting the source document.
- Existing normal pages documents, share links, index rendering, and TODO board
  behavior continue to work.
- If external-file registration is disabled or unavailable, pages continues to
  behave as it does today.
