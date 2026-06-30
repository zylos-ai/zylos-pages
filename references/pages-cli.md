# Pages Agent CLI

The agent CLI is `src/cli/pages.js`. It runs locally, uses the same config/data directory as the service, and writes the Pages SQLite DB/config directly. It does not call HTTP endpoints and does not use API tokens.

## Commands

### Register

```bash
node src/cli/pages.js register --source /absolute/file.md --uri reports/q3 --title "Q3 Report" --component reports
```

- `--source` must be an absolute `.md` or `.html` file path.
- `--uri` is the logical page path used at `/pages/p/<uri>`.
- `--title` defaults to the URI when omitted.
- `--component` optionally restricts validation to one configured allowed source root.
- Registration defaults to `private`; create a share explicitly when public access is needed.

The command calls `registerLogicalPage()`, so the same four validation gates as HTTP registration apply: absolute path, allowed extension, file exists, and source is inside an allowed root.

### List

```bash
node src/cli/pages.js list
node src/cli/pages.js list --q report --json
```

Lists registered logical pages from the DB. `--q` searches page titles.

### Share / Shares / Unshare

```bash
node src/cli/pages.js share reports/q3 --duration 7d
node src/cli/pages.js shares reports/q3
node src/cli/pages.js unshare reports/q3
```

- `share` accepts `24h`, `7d`, `30d`, or `permanent` when config allows permanent shares.
- Registered logical pages are shared as `p/<uri>` and return `/pages/s/<tokenId>`.
- Share link base URL priority is `PAGES_BASE_URL` env var, then `publicBaseUrl` in `config.json`, then the neutral `/pages` path fallback.
- `shares` lists active share tokens for the page.
- `unshare` revokes all active shares for the page.

### Allow Root

```bash
node src/cli/pages.js allow-root add /absolute/reports --name reports
```

Adds a directory to `externalFiles.allowedSources` in the component config. The CLI reads the existing `config.json`, updates only the allowed-root section, and writes it back so existing fields such as `auth.password` remain unchanged.

Use this when an agent stores a source file outside the currently allowed roots. Adding a root expands the trusted source boundary, so keep roots specific.

## JSON Output

All agent-facing commands accept `--json` for machine-readable output:

```bash
node src/cli/pages.js register --source /absolute/file.md --uri reports/q3 --json
```

Errors also return JSON when `--json` is present.
