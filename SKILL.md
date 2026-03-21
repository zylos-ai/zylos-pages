---
name: pages
version: 0.1.0
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

Render Markdown files as styled web pages.

```bash
# Write a page
echo "# Hello World" > ~/zylos/http/public/pages/hello.md

# View it at https://domain/pages/hello
```
