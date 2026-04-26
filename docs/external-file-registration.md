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

## Technical Plan

### Configuration

Extend `src/lib/config.js` with an `externalFiles` section:

```json
{
  "externalFiles": {
    "enabled": true,
    "allowedSources": {
      "recruit": "/home/howard/zylos/components/recruit"
    }
  }
}
```

`allowedSources` is the only policy input pages needs for the first version.
It declares which component data roots can be exposed through pages-managed
symlinks. The configured path should be resolved with `realpath` before use.

The symlink target remains the original external Markdown file. The symlink
itself is created under the existing `contentDir`, so current page rendering,
sharing, cache validation, and navigation continue to use the normal `/pages/*`
flow.

### Registry Location

Use the pages data directory for registry state:

- registry: `~/zylos/components/pages/external-files.json`
- lock directory: `~/zylos/components/pages/external-files.lock`

Suggested registry shape:

```json
{
  "version": 1,
  "entries": {
    "recruit/interview-questions/cand-123-role-4": {
      "slug": "recruit/interview-questions/cand-123-role-4",
      "component": "recruit",
      "sourcePath": "/home/howard/zylos/components/recruit/interview-questions/cand-123-role-4.md",
      "sourceRealPath": "/home/howard/zylos/components/recruit/interview-questions/cand-123-role-4.md",
      "linkPath": "/home/howard/zylos/http/public/pages/recruit/interview-questions/cand-123-role-4.md",
      "createdAt": "2026-04-26T00:00:00.000Z",
      "updatedAt": "2026-04-26T00:00:00.000Z"
    }
  }
}
```

The key should be the normalized slug. The registry is authoritative for which
symlinks pages owns. Pages should not delete or replace symlinks that are not
recorded in this registry.

### CLI Surface

Add a local CLI entrypoint, for example `src/cli/external-files.js`.

Commands:

```bash
node src/cli/external-files.js status --json
node src/cli/external-files.js register \
  --component recruit \
  --source /home/howard/zylos/components/recruit/interview-questions/doc.md \
  --slug recruit/interview-questions/doc \
  --json
node src/cli/external-files.js unregister \
  --slug recruit/interview-questions/doc \
  --json
node src/cli/external-files.js list --json
```

`status --json` should report whether registration is enabled, the pages
content root, and the configured allowed source roots. This lets consumer
components detect capability without writing files.

Successful `register --json` should return:

```json
{
  "ok": true,
  "slug": "recruit/interview-questions/doc",
  "url": "/pages/recruit/interview-questions/doc",
  "linkPath": "/home/howard/zylos/http/public/pages/recruit/interview-questions/doc.md",
  "sourcePath": "/home/howard/zylos/components/recruit/interview-questions/doc.md"
}
```

Failures should return non-zero exit codes and JSON errors when `--json` is
provided:

```json
{
  "ok": false,
  "code": "slug_conflict",
  "error": "slug is already registered to a different source"
}
```

Recommended error codes:

- `disabled`
- `unknown_component`
- `source_missing`
- `source_not_markdown`
- `source_outside_allowed_root`
- `invalid_slug`
- `slug_conflict`
- `normal_page_exists`
- `lock_timeout`
- `registry_corrupt`

### Registration Algorithm

Registration should run under the registry lock:

1. Load config and verify `externalFiles.enabled`.
2. Normalize the requested slug using the same slug semantics as page routing.
3. Resolve `sourcePath` and the component allowed root with `fs.realpath`.
4. Reject the source unless `sourceRealPath` is inside the allowed root.
5. Reject missing sources and non-`.md` sources.
6. Compute `linkPath = path.join(config.contentDir, slug + '.md')`.
7. Reject if `linkPath` exists and is not a pages-owned registry entry.
8. If the slug exists in the registry:
   - same `component` + same `sourceRealPath`: treat as idempotent success
   - different source: reject unless an explicit replacement mode is added
9. Create parent directories for `linkPath`.
10. Create the symlink using a temporary path, then rename it into place.
11. Update `external-files.json` with a temporary file + atomic rename.
12. Return the `/pages/<slug>` URL.

The default link layout should be the actual slug path under `contentDir`
rather than a hidden `_external` directory. That keeps existing page routing
unchanged and gives natural URLs.

### Lock and Atomic Write Details

Use a directory lock such as `fs.mkdirSync(lockPath)` because directory
creation is atomic on local filesystems. The lock directory can contain an
`owner.json` diagnostic file:

```json
{
  "pid": 12345,
  "createdAt": "2026-04-26T00:00:00.000Z",
  "command": "register"
}
```

The CLI should retry for a bounded period before failing with `lock_timeout`.
Stale lock recovery should be conservative: only remove a stale lock if its PID
is no longer alive and the timestamp is older than the configured timeout.

Registry writes should be:

1. write `external-files.json.tmp.<pid>`
2. fsync the temp file
3. rename to `external-files.json`

If symlink creation succeeds but registry write fails, the CLI should remove
the symlink it just created before returning failure.

### Rendering Path Impact

No change is required to `src/routes/pages.js`, `src/services/pageService.js`,
or `src/services/renderService.js` for the basic feature. A registered external
file is just another `.md` file from the renderer's perspective.

The existing cache mtime validation is sufficient for correctness because
`stat(linkPath)` follows the symlink target. If the file watcher misses target
updates outside `contentDir`, the next request still sees a newer target mtime
and invalidates stale cached HTML.

### Index and Navigation Behavior

Registered external pages can appear in the normal Pages index and sidebar as
regular pages. This is acceptable for the first version.

If later folder-aware navigation is implemented, registered files under
`recruit/interview-questions/*` should naturally appear under that folder path.

### Test Plan

Unit-level tests or script-level smoke tests should cover:

- status output when enabled and disabled
- successful register from an allowed root
- idempotent re-register of the same slug/source
- rejection for source outside allowed root after `realpath`
- rejection for missing source
- rejection for non-Markdown source
- rejection for an existing normal pages document
- unregister removes the symlink and registry entry but preserves source
- concurrent register invocations do not lose registry entries
- registered file renders through existing `getPage()` path
- target file update is reflected on the next render request

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
