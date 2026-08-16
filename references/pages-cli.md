# Pages Agent CLI

The agent CLI is `src/cli/pages.js`. It runs locally, uses the same config/data directory as the service, and writes the Pages SQLite DB/config directly. It does not call HTTP endpoints and does not use API tokens.

## Commands

### Register

```bash
node src/cli/pages.js register --source /absolute/file.pdf --uri reports/q3 --title "Q3 Report" --component reports
```

- `--source` must be an absolute path to a regular file.
- `--uri` is the logical page path used at `/pages/p/<uri>`.
- `--title` defaults to the URI when omitted.
- `--component` optionally restricts validation to one configured allowed source root.
- Registration defaults to `private`; create a share explicitly when public access is needed.

The command calls `registerLogicalPage()`, so the same validation gates as HTTP
registration apply: absolute path, regular file, file exists, and the resolved
source is inside an allowed root. Matching requested/real `.md` and `.html`
extensions produce renderable pages; every other file (including a symlink
extension mismatch) produces `type=attachment`. Attachment registration and
download are capped by `security.maxAttachmentSizeBytes`.

### List

```bash
node src/cli/pages.js list
node src/cli/pages.js list --q report --json
```

Lists registered logical pages from the DB, including `type` (`markdown`,
`html`, or `attachment`). `--q` searches page titles.

### Share / Shares / Share-info / Unshare

```bash
node src/cli/pages.js share reports/q3 --duration 7d
node src/cli/pages.js share reports/q3 --duration 7d --password
printf '%s\n' "$SHARE_SECRET" | node src/cli/pages.js share reports/q3 --password-stdin
node src/cli/pages.js shares reports/q3
node src/cli/pages.js shares --all
node src/cli/pages.js share-info <token-id-or-url>
node src/cli/pages.js share-password get <token-id-or-url>
node src/cli/pages.js share-password enable <token-id-or-url>
printf '%s\n' "$SHARE_SECRET" | node src/cli/pages.js share-password rotate <token-id-or-url> --password-stdin
node src/cli/pages.js share-password disable <token-id-or-url>
node src/cli/pages.js unshare --token <token-id>
node src/cli/pages.js unshare reports/q3
```

A share is unprotected by default. `--password` generates a 6-digit numeric
password (easy to relay in chat; brute force is bounded by the per-token
rate limiter, not password entropy); `--password-stdin` reads a provided
4–1024 byte password without placing it in argv. Both explicit secret-returning modes print the
password to stdout, so treat terminal capture and `--json` output as sensitive.

- `share` accepts `24h`, `7d`, `30d`, or `permanent`. Permanent links are always allowed — the `sharing.allowPermanent` gate was removed in 0.7.5, and a leftover key in `config.json` is ignored with a startup warning.
- Registered logical pages are shared as `p/<uri>` and return `/pages/s/<tokenId>`.
- Attachment shares use the same token/password/expiry/revocation ledger. Their
  landing page is `/pages/s/<tokenId>` and bytes are downloaded from
  `/pages/s/<tokenId>/download`.
- Share link base URL priority is `PAGES_BASE_URL` env var, then `publicBaseUrl` in `config.json`, then the neutral `/pages` path fallback.
- `shares <uri>` lists active share tokens for one page.
- `shares --all` lists every live share on the instance, with the uri and protection metadata each token exposes. It never returns plaintext.
- `share-info <token-or-url>` goes the other way: it resolves a link back to its document. It accepts the full share URL or the bare token, and unlike `shares` it deliberately resolves **expired, revoked, and orphaned** links too, reporting `status` as `active`, `expired`, `revoked`, or `document_deleted`, plus a `documentDeleted` flag. The order is strongest-claim-first: revoked beats a later expiry (the deliberate act is not rewritten by the clock) and a deleted document beats expiry (it is a statement about the content, not the calendar). Unknown tokens and non-token input both fail with `share_not_found`.
- `share-password get <token-or-url>` is the only repeat-retrieval command. It deliberately returns one active protected share's password and supports `--json`. Stable failures are `share_not_found`, `not_protected`, `password_custody_unavailable`, and `password_decryption_failed`; it never rotates or substitutes a secret.
- **`share-password enable|rotate|disable <token-or-url>` manage the password of an existing share** — the way to protect an already-circulated link without re-minting it. All three operate on **active** shares only and leave the share URL untouched; the URL remains a bearer secret throughout.
  - `enable` adds a password to an unprotected share; an already-protected share fails with `already_protected` (it never silently rotates). `rotate` replaces the password of a protected share; `disable` removes it so the link opens without a password again — both fail with `not_protected` when there is nothing to rotate or remove.
  - `enable` and `rotate` generate a 6-digit numeric password by default, or read a provided 4–1024 byte (UTF-8) password from stdin via `--password-stdin` — never from argv. They print the secret to stdout **once** (`--json`: `protection.password`), so the same terminal-capture caution as `share --password` applies.
  - Every successful change bumps the share's credential version, which **invalidates all existing browser unlock sessions** for that link; visitors re-enter the (new) password. `disable` clears sessions the same way.
  - Stable failures: `share_not_found` (unknown, expired, or revoked token), `already_protected`, `not_protected`, `invalid_password` (provided secret outside the 4–1024 byte bounds), `credential_conflict` (share changed concurrently — retry), `password_custody_unavailable` (keyring missing/unreadable).
- **`unshare --token <token-id>` revokes exactly one link. `unshare <uri>` revokes EVERY active token on that page** — run `shares <uri>` first and look at what else is live. An unknown token and an already-revoked token both fail with `share_not_found`; the CLI does not distinguish them.
- Revocation sets a flag. The row and its token stay in the table, so revoking is reversible and is not a guarantee that the URL can never work again. Expiry no longer deletes rows either, which is what keeps `share-info` able to answer for lapsed links.
- `unregister <uri>` keeps that page's share rows as tombstones, stamped with the uri the page had, and deletes only the browser sessions. The links stop working at once (every access path resolves through the page row, which is gone), but `share-info` still names the historical document and reports `status: document_deleted`. `shares --all` excludes tombstones — it answers what is exposed now, not what once was. The unregister result reports `tombstonedShares`, not `removedShares`.

### Password keyring operations

Set `sharing.passwordKeyFile` in `config.json` (or
`PAGES_SHARE_PASSWORD_KEY_FILE`) to an absolute path outside `pages.db`, then:

```bash
node src/cli/pages.js share-password keyring init
node src/cli/pages.js share-password keyring rotate
node src/cli/pages.js share-password keyring retire <old-key-id>
```

`init` is exclusive and never replaces a file. `rotate` adds a new active key
and re-encrypts active credential ciphertext before reporting success. `retire`
refuses an active or referenced key. Back up the database and keyring as a
consistent pair before rotation; DB-only restore keeps password verification
but cannot reveal, while keyring-only restore contains no passwords.

Never pass a password value in argv, a URL, an Issue/Task comment, a PR, or a
group message. Deliver the secret only through the intended private channel.

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
