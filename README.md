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

<p align="center">
  <img src="./assets/screenshot.png" alt="zylos-pages screenshot" width="720">
</p>

- **Zero-build publishing** — write a `.md` file, it's instantly a web page
- **Beautiful rendering** — GitHub-style theme with dark/light mode
- **Code highlighting** — VS Code quality syntax highlighting via shiki
- **Fast** — LRU cache + singleflight dedup + file-watch invalidation
- **Navigation sidebar** — slide-out pages list for quick article switching
- **Table of Contents** — independent scrolling TOC for long documents

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

### Verify a page-data migration

The `page_id` schema migration is one-way for older Pages binaries: after it
runs, reverting only the code makes the old binary fail against the re-keyed
database. Take a consistent backup **before** starting the new version. A
SQLite `.backup` includes committed WAL contents; copy attachment storage as
well because attachment directories are also renamed during this migration:

```bash
pages_data_dir=~/zylos/components/pages
pages_backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/zylos-pages-pre-page-id.XXXXXX")"
sqlite3 "$pages_data_dir/pages.db" ".backup '$pages_backup_dir/pages.db'"
cp -a "$pages_data_dir/attachments" "$pages_backup_dir/attachments"
```

Keep that backup until the migration has passed acceptance. Start the new
version so the one-time migration runs, then verify the database and
attachment storage before retiring the migration window:

```bash
PAGES_DATA_DIR=~/zylos/components/pages npm run verify-migration -- --json
```

The command is read-only and exits `0` only when the database schema, page
references, state keys, attachment metadata/files, and migration snapshots all
converge. It exits `1` with machine-readable failures for orphan or duplicate
rows, missing/mismatched/untracked files, legacy URI directories, or residual
snapshot tables. If a state snapshot remains, preserve it as retry evidence;
do not manually drop it. This is a post-migration acceptance check, not a
perpetual naming-convention check or an HTML scan.

If the upgrade must be rolled back, stop Pages first, restore both `pages.db`
and `attachments/` from the pre-migration backup, then revert the code and
start Pages again. **Do not revert the code against the migrated database.**
Confirm the restored old version starts and serves the expected page/state
data before discarding the backup.

## Configuration

Edit `~/zylos/components/pages/config.json`:

```json
{
  "enabled": true,
  "port": 3462,
  "contentDir": "~/zylos/http/public/pages",
  "theme": { "colorScheme": "auto", "codeTheme": "github-dark" },
  "cache": { "enabled": true, "maxEntries": 200, "ttlSeconds": 3600 },
  "security": { "allowRawHtml": false, "maxFileSizeBytes": 1048576 },
  "state": {
    "maxKeysPerPage": 50,
    "maxPageBytes": 1048576,
    "shareWriteRateLimit": { "windowMs": 60000, "max": 12, "ipMax": 30 }
  }
}
```

The `state` ceilings and write-rate limits apply only to share-link visitors;
authenticated owner writes are intentionally exempt.

## Built by Coco

Zylos is the open-source core of [Coco](https://coco.xyz/) — the AI employee platform.

## License

[MIT](./LICENSE)
