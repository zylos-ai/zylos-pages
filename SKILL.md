---
name: pages
version: 0.3.1
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

## Creating HTML Pages (CLI)

```bash
PAGES_DIR="~/.claude/skills/pages"

# List available templates
node $PAGES_DIR/src/cli/pages.js templates

# Create a page from template (writes to the correct content directory)
node $PAGES_DIR/src/cli/pages.js create --template technical-proposal --slug docs/my-report

# Edit the file — replace {{PLACEHOLDER}} values with content

# Create a public share link (no login required)
node $PAGES_DIR/src/cli/pages.js share docs/my-report --duration 30d
```

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
| `references/html-rendering.md` | When creating HTML artifacts (`.html` files), choosing between Markdown vs HTML mode, or needing to understand CSP constraints, dark mode, CJK typography, and responsive design best practices |
| `templates/html/README.md` | When generating HTML reports — lists available templates, usage instructions, and the shared design system |

## HTML Report Templates

Four standalone HTML templates are available in `templates/html/`:

| Template | Use case |
|----------|----------|
| `research-report.html` | Research/investigation reports with summary, findings, and recommendations |
| `technical-proposal.html` | Technical proposals with architecture sections, pros/cons comparison |
| `comparison.html` | A-vs-B product or technology comparisons with scoring |
| `evaluation.html` | Candidate or vendor evaluations with rating breakdowns |

All templates share `templates/html/base.css` (design tokens, dark mode, CJK fonts, responsive layout). Copy a template, fill in content, and save as `.html` in the pages directory.
