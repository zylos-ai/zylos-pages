---
name: pages
version: 0.7.6
description: >
  Markdown-to-HTML rendering component for zylos. Renders .md files as beautifully
  styled web pages with code highlighting, dark/light theme, and table of contents.
  Use when writing reports, documentation, or any content that should be published
  as a web page. Agent writes a .md file, it's immediately accessible via URL.
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

Render Markdown and HTML files as styled web pages.

## Agent CLI (Local DB)

Use this CLI when an agent needs to register local Markdown/HTML files, manage share links, or add an allowed source root. It runs locally and writes the Pages DB/config directly; it does not use HTTP or tokens.

```bash
PAGES_DIR="~/.claude/skills/pages"

# Register a local source file as a logical page. Default access is private.
node $PAGES_DIR/src/cli/pages.js register --source /absolute/report.md --uri reports/q3 --title "Q3 Report"

# List registered logical pages.
node $PAGES_DIR/src/cli/pages.js list

# Inspect share links. `shares --all` covers the whole instance and is the
# way to answer "what passwordless links exist on this box right now?".
node $PAGES_DIR/src/cli/pages.js shares reports/q3
node $PAGES_DIR/src/cli/pages.js shares --all

# The inverse: someone hands you a link, find out which document it is.
# Resolves expired and revoked links too, and takes the full URL or the token.
node $PAGES_DIR/src/cli/pages.js share-info https://domain/s/<token-id>

# Mint a passwordless link. NOT a default step — see Sharing below.
node $PAGES_DIR/src/cli/pages.js share reports/q3 --duration 7d

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

Registering a page protects it with the pages password. `share` does not:
it mints `/s/<token>`, which is served through a share-access session that
skips authentication entirely. Anyone holding the URL can read the page —
no login, no account, no audit trail of who opened it.

So:

- **Registering is the default. Sharing is not.** Finish the job by
  reporting the internal URL or the file path.
- **Mint a link only on an explicit request** from whoever owns the
  document, and tell them it is public and passwordless when you hand it
  over. "Visible inside the company" is a different thing from "readable by
  anyone on the internet who has the URL" — do not treat the first as
  license for the second.
- **Prefer a duration over `permanent`.** Nothing in the config gates
  permanent links — an expiry is the only thing that limits how long a
  passwordless URL keeps working, so pick the shortest one that does the job.

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

- Rows are never deleted. Expired links stay in the table alongside revoked
  ones, so every link ever minted can still be traced back to its document.
- `shares --all` lists every **live** share on the instance. Use it before
  concluding anything about this box's exposure; per-page `shares <uri>`
  cannot answer that question.
- `share-info <token-or-url>` goes the other way: hand it a link somebody
  sends you and it names the document, when it was shared, for how long, and
  whether it is still active, expired, or revoked. It takes the full URL or
  just the token.

## Creating HTML Pages (CLI)

```bash
PAGES_DIR="~/.claude/skills/pages"

# List available templates
node $PAGES_DIR/src/cli/pages.js templates

# Create a page from template (writes to the correct content directory)
node $PAGES_DIR/src/cli/pages.js create --template technical-proposal --slug docs/my-report

# Edit the file — replace {{PLACEHOLDER}} values with content
```

The page is now registered and reachable behind the pages password. That is
the end of the normal flow — report the internal URL and stop there.

**Do not create a share link as a routine step.** `share` mints a
`/s/<token>` URL that bypasses login entirely: anyone with the link reads the
page, no password, no account. Create one only when the person who owns the
document asks for a link they can hand to someone, and when you do, say
plainly that it is public and passwordless. See the "Sharing" section above.

Templates: `technical-proposal`, `research-report`, `comparison`, `evaluation`.

## Quick Start (Markdown)

```bash
# Write a page
echo "# Hello World" > ~/zylos/http/public/pages/hello.md

# View it at https://domain/pages/hello
```

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
