# Dev Plan: Folder-Aware Navigation (#18)

## Summary

Replace the flat page list in the index page and article sidebar with folder-grouped navigation. 362 pages currently render as a single flat list — daily-digest alone has 175 entries. Add folder grouping, collapsible sections, and breadcrumb folder paths.

## Scope

**In scope:**
- `buildPageTree()` helper that transforms flat `scanPages()` output into a two-level grouped structure
- Index page: folder groups using `<details><summary>`, collapsed by default, with page count badges
- Nav sidebar: folder groups with nested `<ul>`, active page's folder auto-expanded
- Breadcrumbs: `Pages > folder-name > page-title` for nested pages (folder segment as `<span>`, not link)
- CSS for folder groups, badges, indentation

**Out of scope:**
- Folder landing route / folder index page (no evidence of need)
- Deep nesting beyond two levels
- Collapsible sidebar toggle button
- Search or filtering

## Development Checklist

- [ ] **1. `buildPageTree()` helper** — Add to `src/routes/index.js`. Input: flat page array from `scanPages()`. Output: `{ topLevel: Page[], folders: { name: string, pages: Page[] }[] }`. Top-level = pages with no `/` in slug. Folders sorted alphabetically, pages within folders sorted by date (newest first). Export for reuse in page route.
- [ ] **2. Index template grouping** — Update `src/templates/indexTemplate.js` to accept tree structure instead of flat array. Render top-level pages first as flat list, then each folder as `<details><summary>folder-name (N)</summary><ul>...</ul></details>`. Folders collapsed by default.
- [ ] **3. Index route** — Update `src/routes/index.js` to call `buildPageTree()` and pass tree to template.
- [ ] **4. Sidebar grouping** — Update `renderNavSidebar()` in `src/templates/pageTemplate.js`. Group pages by folder. Active page's folder rendered with `open` attribute or expanded class. Folder heading as plain `<span>`, not a link.
- [ ] **5. Breadcrumb enhancement** — Update breadcrumb rendering in `pageTemplate.js`. For slugs containing `/`, show folder path segments between "Pages" and the page title. Folder segments as `<span class="breadcrumb-folder">`.
- [ ] **6. CSS styling** — Add styles to `assets/style.css` for: folder group containers, summary/details styling, folder page count badge, sidebar folder headings, sidebar indent for nested pages, breadcrumb folder segments.
- [ ] **7. Page route integration** — Ensure `src/routes/pages.js` passes full page list + current slug to `injectNavSidebar()` so sidebar knows which folder to expand.

## Test Checklist

- [ ] `buildPageTree()` unit test: flat input with mixed top-level and nested pages produces correct tree
- [ ] `buildPageTree()` unit test: empty input returns empty topLevel and folders
- [ ] `buildPageTree()` unit test: pages within folders sorted by date descending
- [ ] `buildPageTree()` unit test: folders sorted alphabetically
- [ ] Index template: folder groups render with `<details>` and page count in `<summary>`
- [ ] Sidebar: active page's folder is expanded, other folders collapsed
- [ ] Breadcrumb: nested page shows folder path; top-level page unchanged
- [ ] Manual verification: index page loads with grouped folders at production scale (362 pages)
- [ ] Manual verification: sidebar correctly highlights active page and expands its folder
- [ ] Manual verification: existing page URLs remain accessible (no routing changes)

## Assumptions

- `scanPages()` output already includes nested slugs with `/` separator (e.g. `daily-digest/2026-06-14-morning`) — **guaranteed by current code** (`src/routes/index.js:77`)
- Folder name is derived from the first path segment of the slug — **guaranteed** (single level of nesting in production data)
- No pages exist at depth > 2 in production — **validated** (checked actual content directory; deepest is `recruit/interview-questions/` but this is 2 levels, same pattern)
- `injectNavSidebar()` is called post-cache with fresh page list — **guaranteed by current code** (`src/routes/pages.js`)

## Acceptance Checklist

- [ ] Index page shows folders as collapsible groups with page count badges
- [ ] Top-level pages appear separately (not in any folder group)
- [ ] Folders are collapsed by default
- [ ] Expanding a folder shows its pages sorted by date (newest first)
- [ ] Sidebar groups pages by folder, active page's folder is expanded
- [ ] Breadcrumbs show `Pages > folder > title` for nested pages
- [ ] Breadcrumbs show `Pages > title` for top-level pages (unchanged)
- [ ] All existing page URLs still work (no routing regression)
- [ ] `npm test` passes with all new + existing tests
- [ ] Browser screenshots: index page, sidebar with active nested page, breadcrumbs
- [ ] No visual regressions on top-level pages
