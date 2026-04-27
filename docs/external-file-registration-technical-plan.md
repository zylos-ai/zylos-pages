# External File Registration Technical Plan

This document contains the implementation plan for
[External File Registration](external-file-registration.md).

## Configuration

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

## Registry Location

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

## CLI Surface

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

## Registration Algorithm

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

## Lock and Atomic Write Details

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

## Rendering Path Impact

No change is required to `src/routes/pages.js`, `src/services/pageService.js`,
or `src/services/renderService.js` for the basic feature. A registered external
file is just another `.md` file from the renderer's perspective.

The existing cache mtime validation is sufficient for correctness because
`stat(linkPath)` follows the symlink target. If the file watcher misses target
updates outside `contentDir`, the next request still sees a newer target mtime
and invalidates stale cached HTML.

## Index and Navigation Behavior

Registered external pages can appear in the normal Pages index and sidebar as
regular pages. This is acceptable for the first version.

If later folder-aware navigation is implemented, registered files under
`recruit/interview-questions/*` should naturally appear under that folder path.

## Test Plan

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
