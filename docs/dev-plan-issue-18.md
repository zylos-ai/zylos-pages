# Dev Plan: Folder-Aware Navigation (#18)

## Summary

Replace the flat page list in the index page and article sidebar with folder-grouped navigation. 362 pages currently render as a single flat list — daily-digest alone has 175 entries. Add folder grouping, collapsible sections, and breadcrumb folder paths.

## Scope

**In scope:**
- Shared `buildPageTree()` helper in `src/utils/pageTree.js`
- Folder grouping by full dirname path (e.g. `recruit/interview-questions` is one folder group, not nested under `recruit`)
- Index page: folder groups using `<details><summary>`, collapsed by default, with page count badges
- Nav sidebar: folder groups with nested `<ul>`, active page's folder auto-expanded
- Breadcrumbs: `Pages > folder-segment > ... > page-title` for nested pages (folder segments as `<span>`, not links)
- CSS for folder groups, badges, indentation

**Out of scope:**
- Folder landing route / folder index page (no evidence of need)
- Recursive tree UI (folders are flat groups keyed by full dirname; UI renders one level of groups)
- Collapsible sidebar toggle button
- Search or filtering

## Development Checklist

- [ ] **1. Shared `buildPageTree()` helper** — Create `src/utils/pageTree.js`. Input: flat page array from `scanPages()`. Output: `{ topLevel: Page[], folders: [{ path: string, label: string, pages: Page[] }] }`. Folder key = full dirname of slug (e.g. slug `recruit/interview-questions/foo` → folder path `recruit/interview-questions`, label `recruit / interview-questions`). Top-level = pages with no `/` in slug. Folders sorted alphabetically by path, pages within folders sorted by date (newest first).
- [ ] **2. Index template grouping** — Update `src/templates/indexTemplate.js` to accept `{ topLevel, folders }` instead of flat array. Render top-level pages first as flat list, then each folder as `<details><summary>folder-label (N)</summary><ul>...</ul></details>`. All folder names/labels passed through `escapeHtml()`. Folders collapsed by default.
- [ ] **3. Index route** — Update `src/routes/index.js` to import `buildPageTree()` from shared helper, pass tree to template.
- [ ] **4. Sidebar grouping** — Update `injectNavSidebar()` and `renderNavSidebar()` in `src/templates/pageTemplate.js` to import and use the same `buildPageTree()` helper. Folder heading as plain `<span>` (not a link). Active page's folder rendered expanded. All folder names passed through `escapeHtml()`.
- [ ] **5. Breadcrumb enhancement** — Update breadcrumb rendering in `pageTemplate.js`. For slugs containing `/`, derive folder segments from the slug path and display between "Pages" and the page title. Each folder segment as `<span class="breadcrumb-folder">`, escaped with `escapeHtml()`.
- [ ] **6. CSS styling** — Add styles to `assets/style.css` for: folder group containers, details/summary styling, folder page count badge, sidebar folder headings, sidebar indent for nested pages, breadcrumb folder segments.
- [ ] **7. Page route integration** — Ensure `src/routes/pages.js` passes full page list + current slug to `injectNavSidebar()` so sidebar knows which folder to expand (already the case — verify no changes needed).

## Test Checklist

### Unit tests (pageTree helper)
- [ ] Flat input with mixed top-level and nested pages produces correct tree
- [ ] Empty input returns empty topLevel and folders
- [ ] Pages within folders sorted by date descending
- [ ] Folders sorted alphabetically by path
- [ ] Multi-segment folder: slug `recruit/interview-questions/foo` grouped under path `recruit/interview-questions`
- [ ] Label for multi-segment folder: `recruit / interview-questions`

### Integration test (scanPages + buildPageTree)
- [ ] Temp content dir with: top-level page, `.hidden.md`, `_underscore.md`, frontmatter `draft: true`, `daily-digest/a.md`, `recruit/interview-questions/foo.md`. Verify: hidden/draft/underscore pages excluded, multi-segment path correct, top-level separate from folders.

### Template tests
- [ ] Index template: folder groups render with `<details>` and page count in `<summary>`
- [ ] Index template: folder names are HTML-escaped (no raw slug segments in HTML)
- [ ] Sidebar: active page's folder is expanded, other folders collapsed
- [ ] Sidebar: folder names are HTML-escaped
- [ ] Breadcrumb: nested page shows folder path segments; top-level page unchanged
- [ ] Breadcrumb: folder segments are HTML-escaped

### Manual verification
- [ ] Index page loads with grouped folders at production scale (362 pages)
- [ ] Sidebar correctly highlights active page and expands its folder
- [ ] Existing page URLs remain accessible (no routing changes)
- [ ] Links use `${baseUrl}/${encodeURI(page.slug)}` pattern (forwarded-prefix compatibility)

## Assumptions

- `scanPages()` output includes nested slugs with `/` separator (e.g. `daily-digest/2026-06-14-morning`) — current deployed environment produces slash slugs; helper treats slugs as URL paths, splitting on `/`
- Folder grouping key is the full dirname of the slug (`slug.substring(0, slug.lastIndexOf('/'))`) — this correctly handles multi-segment paths like `recruit/interview-questions/foo`
- `injectNavSidebar()` is called post-cache with fresh page list — **verified** in `src/routes/pages.js:50-58`: `scanPages()` then `injectNavSidebar()` on each non-share request
- UI renders folder groups as a flat list of groups (not a recursive tree) — the group key is the full dirname path, so `recruit/interview-questions` is a single group, not `recruit` containing `interview-questions`
- `scanPages()` already excludes hidden/draft files — no changes to scan logic needed

## Acceptance Checklist

- [ ] Index page: desktop view with collapsed folder groups, each showing page count badge
- [ ] Index page: expanded `daily-digest` folder showing pages sorted by date
- [ ] Index page: top-level pages listed separately above/below folder groups
- [ ] Sidebar: article view on a nested page (e.g. `daily-digest/2026-06-14-morning`) with its folder expanded
- [ ] Sidebar: other folders collapsed
- [ ] Breadcrumb: nested page shows `Pages > daily-digest > page-title`
- [ ] Breadcrumb: multi-segment nested page shows `Pages > recruit > interview-questions > page-title`
- [ ] Breadcrumb: top-level page shows `Pages > page-title` (unchanged)
- [ ] Draft/hidden files not visible (behavior unchanged)
- [ ] All existing page URLs still work (no routing regression)
- [ ] `npm test` passes with all new + existing tests
- [ ] Browser screenshots: index (collapsed), index (folder expanded), sidebar (active nested page), breadcrumb (nested), breadcrumb (top-level)
