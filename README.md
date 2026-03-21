<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-pages</h1>

<p align="center">
  Markdown-to-HTML rendering component for zylos — write .md, get beautiful web pages
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://discord.gg/GS2J39EGff"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/ZylosAI"><img src="https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white" alt="X"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
  <a href="https://coco.xyz"><img src="https://img.shields.io/badge/Built%20by-Coco-orange" alt="Built by Coco"></a>
</p>

---

- **Zero-build publishing** — write a `.md` file, it's instantly a web page
- **Beautiful rendering** — GitHub-style theme with dark/light mode
- **Code highlighting** — VS Code quality syntax highlighting via shiki
- **Fast** — LRU cache + singleflight dedup + file-watch invalidation

## Install

```bash
zylos add pages
```

Or manually:

```bash
cd ~/zylos/.claude/skills
git clone https://github.com/zylos-ai/zylos-pages.git pages
cd pages && npm install
```

## Usage

```bash
# Write a page
echo "# Hello World" > ~/zylos/http/public/pages/hello.md

# Visit https://your-domain/pages/hello
# Or browse all pages at https://your-domain/pages/
```

### Frontmatter

```yaml
---
title: My Report
description: Q1 competitive analysis
date: 2026-03-21
tags: [research, competitive]
toc: true
---
```

## Configuration

Edit `~/zylos/components/pages/config.json`:

```json
{
  "enabled": true,
  "port": 3461,
  "contentDir": "~/zylos/http/public/pages",
  "theme": { "colorScheme": "auto", "codeTheme": "github-dark" },
  "cache": { "enabled": true, "maxEntries": 200, "ttlSeconds": 3600 },
  "security": { "allowRawHtml": false, "maxFileSizeBytes": 1048576 }
}
```

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
