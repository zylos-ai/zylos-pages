# CLAUDE.md

## Project Overview

zylos-pages is a Markdown-to-HTML rendering component for zylos. It serves `.md` files as styled web pages with code highlighting, dark/light theme, and table of contents.

- **Runtime:** Node.js (ESM), Express
- **Service:** PM2 (`zylos-pages`)
- **Port:** 3462 (configurable via `PAGES_PORT`)
- **Config:** `~/zylos/components/pages/config.json` (preserved across upgrades)

## Source Structure

```
src/
  index.js          # Entry point, Express app setup
  lib/              # Config loading
  routes/           # Express route handlers
  templates/        # HTML template generators
  markdown/         # Markdown rendering pipeline
  security/         # Auth, headers (CSP), sanitization
  cache/            # LRU cache with singleflight
  sharing/          # Share token manager
  services/         # File watcher
  utils/            # Helpers
assets/             # Static files (CSS, JS, images) served at /_assets/
hooks/              # Lifecycle hooks (post-install, pre/post-upgrade)
```

## Security

- **CSP:** `script-src 'self'` — all JavaScript must be in external files under `assets/`. Never use inline `<script>` tags in templates.
- **Auth:** Cookie-based session with scrypt password hashing, brute-force protection.
- **Input sanitization:** `escapeHtml()` for all user content and `isSafeUrl()` for links.
- Always run new features through code review (request via HXA to Jinglever).

## Release Checklist

When bumping a version:

1. Update version in **all three files**:
   - `package.json`
   - `package-lock.json` (two locations: root `version` and `packages[""].version`)
   - `SKILL.md` (frontmatter `version` field)
2. Add a changelog entry to `CHANGELOG.md` following Keep a Changelog format
3. Commit, create PR, get review approval, merge
4. Tag: `git tag v{VERSION}` and push: `git push origin v{VERSION}`
5. Create GitHub release: `gh release create v{VERSION}` with changelog notes
6. Deploy: `zylos upgrade pages`

## Branch Protection

- `main` branch requires PR with at least one approval from a non-pusher
- Jinglever is the designated reviewer — contact via HXA-Connect DM (not GitHub assign)

## Development

```bash
npm run dev    # Start with --watch for auto-reload
npm start      # Production start
```

## Testing Changes Locally

The deployed skill code is at `~/.claude/skills/pages/`. For quick hotfixes, edit there and `pm2 restart zylos-pages`. For proper changes, work in the workspace repo, PR, merge, then `zylos upgrade pages`.
