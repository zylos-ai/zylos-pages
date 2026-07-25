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

### Share / Shares / Share-info / Unshare

```bash
node src/cli/pages.js share reports/q3 --duration 7d
node src/cli/pages.js shares reports/q3
node src/cli/pages.js shares --all
node src/cli/pages.js share-info <token-id-or-url>
node src/cli/pages.js unshare --token <token-id>
node src/cli/pages.js unshare reports/q3
```

A share link is passwordless: anyone holding `/s/<tokenId>` reads the page with
no login. Read the Sharing section of `SKILL.md` before minting one.

- `share` accepts `24h`, `7d`, `30d`, or `permanent`. Permanent links are always allowed — the `sharing.allowPermanent` gate was removed in 0.7.5, and a leftover key in `config.json` is ignored with a startup warning.
- Registered logical pages are shared as `p/<uri>` and return `/pages/s/<tokenId>`.
- Share link base URL priority is `PAGES_BASE_URL` env var, then `publicBaseUrl` in `config.json`, then the neutral `/pages` path fallback.
- `shares <uri>` lists active share tokens for one page.
- `shares --all` lists every live share on the instance, with the uri each token exposes. This is the only way to answer "what passwordless links exist on this box right now?" without reading the SQLite file directly.
- `share-info <token-or-url>` goes the other way: it resolves a link back to its document. It accepts the full share URL or the bare token, and unlike `shares` it deliberately resolves **expired and revoked** links too, reporting `status` as `active`, `expired`, or `revoked`. Unknown tokens and non-token input both fail with `share_not_found`.
- **`unshare --token <token-id>` revokes exactly one link. `unshare <uri>` revokes EVERY active token on that page** — run `shares <uri>` first and look at what else is live. An unknown token and an already-revoked token both fail with `share_not_found`; the CLI does not distinguish them.
- Revocation sets a flag. The row and its token stay in the table, so revoking is reversible and is not a guarantee that the URL can never work again. Share rows are never deleted, including expired ones, which is what keeps `share-info` able to answer for old links.

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
