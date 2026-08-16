---
name: pages
version: 0.9.1
description: >
  Registered Markdown, HTML, and downloadable file pages for zylos. Use for styled
  documents or when a local file should be exposed as a safe attachment page.
  Agents register the source with the pages CLI and report the internal URL; files
  are served only after registration.
type: capability

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-pages
    entry: src/index.js
  data_dir: ~/zylos/components/pages
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json

upgrade:
  repo: zylos-ai/zylos-pages
  branch: main

config:
  optional:
    - name: PAGES_PORT
      description: HTTP port for the pages service
      default: "3462"

http_routes:
  - path: /pages/*
    type: reverse_proxy
    target: localhost:3462
    strip_prefix: /pages

dependencies: []
---

# Zylos Pages

Render Markdown and HTML files as styled web pages, or expose arbitrary files as safe download pages.

## Agent CLI (Local DB)

Use this CLI when an agent needs to register local Markdown/HTML/download files, manage share links, or add an allowed source root. It runs locally and writes the Pages DB/config directly; it does not use HTTP or tokens.

```bash
PAGES_DIR="$HOME/zylos/.claude/skills/pages"

# Register a local source file as a logical page. Default access is private.
node $PAGES_DIR/src/cli/pages.js register --source /absolute/report.md --uri reports/q3 --title "Q3 Report"

# List registered logical pages.
node $PAGES_DIR/src/cli/pages.js list

# Inspect live share links. Protection metadata is included, never plaintext.
node $PAGES_DIR/src/cli/pages.js shares reports/q3
node $PAGES_DIR/src/cli/pages.js shares --all

# The inverse: someone hands you a link, find out which document it is.
# Resolves expired and revoked links too, and takes the full URL or the token.
node $PAGES_DIR/src/cli/pages.js share-info https://domain/s/<token-id>

# Mint an unprotected link. NOT a default step — see Sharing below.
node $PAGES_DIR/src/cli/pages.js share reports/q3 --duration 7d

# Mint a protected link with a generated password. This explicit command
# returns the secret on stdout; deliver it only through the intended private DM.
node $PAGES_DIR/src/cli/pages.js share reports/q3 --duration 7d --password

# A provided password is read from stdin, never argv or a URL.
printf '%s\n' "$SHARE_SECRET" | node $PAGES_DIR/src/cli/pages.js share reports/q3 --password-stdin

# Explicit repeat retrieval. Ordinary shares/share-info never return plaintext.
node $PAGES_DIR/src/cli/pages.js share-password get https://domain/s/<token-id>

# Manage the password of an EXISTING share without changing its URL.
# enable/rotate generate a 6-digit password (or take one on stdin) and print
# the secret once; disable makes the link open without a password again.
node $PAGES_DIR/src/cli/pages.js share-password enable https://domain/s/<token-id>
printf '%s\n' "$SHARE_SECRET" | node $PAGES_DIR/src/cli/pages.js share-password rotate <token-id> --password-stdin
node $PAGES_DIR/src/cli/pages.js share-password disable <token-id>

# Custody keyring maintenance (init/rotate/retire) is rare operator work:
# see references/pages-cli.md before running share-password keyring commands.

# Revoke. Prefer --token: the uri form revokes EVERY token on that page,
# which will also kill links you did not mean to touch.
node $PAGES_DIR/src/cli/pages.js unshare --token <token-id>
node $PAGES_DIR/src/cli/pages.js unshare reports/q3

# Remove a logical page registration and page-id keyed share/session rows.
# The source file on disk is left untouched.
node $PAGES_DIR/src/cli/pages.js unregister reports/q3

# Add a local directory to the allowed source roots.
node $PAGES_DIR/src/cli/pages.js allow-root add /absolute/reports --name reports
```

Long-form parameter details and safety notes: `references/pages-cli.md`.

## Sharing

Registering a page protects it with the Pages owner password. `share` mints
`/s/<token>` and is unprotected unless `--password` or `--password-stdin` is
selected. The URL remains a bearer secret even when a second password is used.

So:

- **Registering is the default. Sharing is not.** Finish the job by
  reporting the internal URL or the file path.
- **Mint a link only on an explicit request** from whoever owns the
  document. State whether it is protected or unprotected when you hand it
  over. "Visible inside the company" is a different thing from "readable by
  anyone on the internet who has the URL" — do not treat the first as
  license for the second.
- **Prefer a duration over `permanent`.** Pick the shortest lifetime that does
  the job, whether or not a password is present.
- **Deliver passwords only in the intended private conversation.** Never put
  them in a project group, Issue/Task comment, PR, KB page, command argument,
  URL, or routine log. For Agent reads, send `X-Zylos-Share-Password` only on
  `GET`/`HEAD /s/<token>`, `/s/<token>.md`, or
  `/s/<token>/download`; it does not authorize writes.
- A protected link does not hide a parallel live unprotected link to the same
  page. Both owner consoles warn about this condition without blocking work.

Revoking:

- `unshare --token <token-id>` revokes exactly that link.
- `unshare <uri>` revokes **every** token on that page. Run
  `shares <uri>` first and look at what else is live — this is how a
  routine cleanup takes out a permanent link somebody was still using.
- **Revocation is a reversible marker, not destruction.** It sets a flag;
  the row and its token stay in the table, so a revoked link can be brought
  back by clearing that flag. This is deliberate — it is how a mistaken
  `unshare <uri>` gets undone — but it means "revoked" is not a guarantee
  that the URL can never work again. Do not rely on it as one.

Accounting for links:

- Rows are never deleted — not on expiry, not when the document itself is
  unregistered. Every link ever minted can still be traced back to the document
  it exposed. What dies is access, not the record.
- **Unregistering a document leaves a tombstone.** `unregister <uri>` keeps
  that page's share rows and stamps them with the uri the page had, because the
  uri lives in the page row and that row is about to go. The links stop working
  immediately — every access path resolves through the page row — but
  `share-info` still answers "that was `q3/plan`, and the document is gone".
  Live-exposure listings exclude tombstones: `shares --all` reports what this
  box actually serves, not what it remembers.
- `unregister` reports `tombstonedShares` (rows kept) and `removedSessions`
  (browser sessions destroyed). It used to report `removedShares`; a count of
  retained rows under a name saying "removed" is how an operator concludes the
  links were purged.
- `shares --all` lists every **live** share on the instance. Use it before
  concluding anything about this box's exposure; per-page `shares <uri>`
  cannot answer that question.
- `share-info <token-or-url>` goes the other way: hand it a link somebody
  sends you and it names the document, when it was shared, for how long, and
  its status — `active`, `expired`, `revoked`, or `document_deleted`. Ranked
  strongest claim first, so a revoked link that later lapsed still reads
  `revoked`, and a deleted document outranks a spent clock. It takes the full
  URL or just the token.

## Creating HTML Pages (CLI)

```bash
PAGES_DIR="$HOME/zylos/.claude/skills/pages"

# List available templates
node $PAGES_DIR/src/cli/pages.js templates

# Create a page from template (writes to the correct content directory)
node $PAGES_DIR/src/cli/pages.js create --template technical-proposal --slug docs/my-report

# Edit the file — replace {{PLACEHOLDER}} values with content
```

The page is now registered and reachable behind the pages password. That is
the end of the normal flow — report the internal URL and stop there.

**Do not create a share link as a routine step.** `share` mints a
`/s/<token>` URL that bypasses owner login. Create one only when the person who
owns the document asks for a link they can hand to someone, choose protected
or unprotected deliberately, and state that choice. See "Sharing" above.

Templates: `technical-proposal`, `research-report`, `comparison`, `evaluation`.

## Registering a Downloadable File

```bash
PAGES_DIR="$HOME/zylos/.claude/skills/pages"
node "$PAGES_DIR/src/cli/pages.js" register \
  --source /absolute/file.pdf --uri files/report --title "Report PDF"
```

Only sources whose requested extension and real (symlink-resolved) extension
both match `.md` or `.html` enter a renderer. Every other regular file becomes
`type=attachment`. The owner opens `/pages/p/files/report` and downloads from
`/pages/p/files/report/download`; shared visitors use `/pages/s/<token>` and
`/pages/s/<token>/download`. Never create a share unless the document owner
explicitly asks for one.

Attachment downloads are capped by `security.maxAttachmentSizeBytes` (50 MiB
by default), use a MIME extension allowlist with an octet-stream fallback,
force attachment disposition, and never enter raw Markdown, state, embedded
photo, logical-asset, render, or page-cache paths.

## Quick Start (Markdown)

```bash
PAGES_DIR="$HOME/zylos/.claude/skills/pages"
# Content root = contentDir in ~/zylos/components/pages/config.json
CONTENT_DIR="$(node -p "require(process.env.HOME+'/zylos/components/pages/config.json').contentDir || process.env.HOME+'/zylos/http/public/pages'")"

# 1. Write the markdown file under the content root (or any allowed source root)
echo "# Hello World" > "$CONTENT_DIR/hello.md"

# 2. Register it — pages are ONLY served after registration
node "$PAGES_DIR/src/cli/pages.js" register \
  --source "$CONTENT_DIR/hello.md" --uri hello --title "Hello World"

# 3. Report the internal URL: https://domain/pages/p/hello
#    (behind the pages owner password; see Sharing before minting links)
```

Writing a file alone is not enough: unregistered files under the content
directory are not served (the request 404s after login). This changed in
v0.9.0 — registration is the gate for every page.

## References

| Document | When to read |
|----------|-------------|
| `references/pages-cli.md` | When registering local source files, sharing/unsharing logical pages, adding allowed source roots, or checking the local DB CLI contract |
| `references/html-rendering.md` | When creating HTML artifacts (`.html` files), choosing between Markdown vs HTML mode, or needing to understand CSP constraints, dark mode, CJK typography, and responsive design best practices |
| `templates/html/README.md` | When generating HTML reports — lists available templates, usage instructions, and the shared design system |

## HTML Report Templates

Five standalone HTML templates are available in `templates/html/`:

| Template | Use case |
|----------|----------|
| `research-report.html` | Research/investigation reports with summary, findings, and recommendations |
| `technical-proposal.html` | Technical proposals with architecture sections, pros/cons comparison |
| `comparison.html` | A-vs-B product or technology comparisons with scoring |
| `evaluation.html` | Candidate or vendor evaluations with rating breakdowns |
| `interview-questions.html` | Interview question guides with hypotheses, pacing notes, and judgment framework |

All templates share `templates/html/base.css` (design tokens, dark mode, CJK fonts, responsive layout). Copy a template, fill in content, and save as `.html` in the pages directory.
