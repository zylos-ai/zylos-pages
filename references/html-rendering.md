# HTML Rendering in Pages

Pages supports two rendering modes: **Markdown** and **HTML**. The mode is determined by file extension.

## Rendering Modes

| | Markdown (`.md`) | HTML (`.html`) |
|---|---|---|
| **Rendering** | Converted to styled HTML with code highlighting, ToC, theme toggle | Served as-is inside an iframe wrapper |
| **Styling** | Pages applies its own CSS (style.css) | Author controls all CSS |
| **Navigation** | Integrated into page layout with sidebar | Wrapped in an iframe; sidebar available on outer frame |
| **Use when** | Text-heavy content, reports, documentation | Custom layouts, dashboards, interactive pages, complex visual designs |

## File Placement

Both file types go in the same content directory:

```
~/zylos/http/public/pages/
├── proposals/
│   ├── my-proposal.md          → /pages/proposals/my-proposal
│   └── backup-strategy.html    → /pages/proposals/backup-strategy
├── daily-digest/
│   └── 2026-06-23-morning.md   → /pages/daily-digest/2026-06-23-morning
└── welcome.md                  → /pages/welcome
```

The file extension is stripped from the URL. A `.html` file and a `.md` file with the same base name would conflict — avoid this.

## When to Use Each Mode

### Use Markdown when:
- Content is primarily text with headings, lists, tables, code blocks
- You want consistent styling with automatic dark/light theme
- Standard report format (Lark digests, research summaries, meeting notes)
- Quick publishing — just write and drop the file

### Use HTML when:
- Layout needs go beyond what Markdown supports (multi-column, cards, grids)
- Custom CSS is essential to the content (visual comparisons, styled dashboards)
- Interactive elements are needed (collapsible sections, tabs, custom JS)
- Precise control over typography and spacing is required
- The document is a designed artifact, not just text

## HTML Artifact Behavior

HTML files are rendered differently from Markdown:

1. **Iframe isolation**: The HTML content loads inside an iframe. This gives the author full CSS control without conflicting with Pages' own styles.
2. **CSP**: HTML artifacts have a separate Content-Security-Policy (`HTML_ARTIFACT_CSP`) — inline styles are allowed, inline scripts are not.
3. **Raw mode**: Append `?raw=1` to serve the HTML directly without the iframe wrapper.
4. **Sharing**: Shared HTML artifacts are served directly (no iframe) since they are complete page designs.

## Writing HTML Artifacts

### Minimal structure

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Report Title</title>
  <style>
    /* All CSS goes here — inline styles are allowed in HTML artifacts */
  </style>
</head>
<body>
  <h1>Report Title</h1>
  <!-- content -->
</body>
</html>
```

### Best practices

- **Set `<title>`**: Pages extracts it for the navigation sidebar and browser tab.
- **Include viewport meta**: Ensures responsive behavior on mobile.
- **Use `lang` attribute**: Set `zh-CN` for Chinese content, `en` for English, to get correct CJK line-breaking and hyphenation.
- **No inline `<script>` tags**: CSP blocks them. Use `<style>` for CSS (allowed) or reference external scripts via `_assets/`.
- **Self-contained CSS**: Put all styles in a `<style>` block. No external CSS dependencies except Google Fonts.
- **Dark mode support**: Use `prefers-color-scheme` media query or CSS custom properties with a toggle.

### Dark mode pattern

```css
:root {
  --bg: #ffffff;
  --text: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --card-bg: #f9fafb;
  --accent: #2563eb;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111827;
    --text: #f3f4f6;
    --muted: #9ca3af;
    --border: #374151;
    --card-bg: #1f2937;
    --accent: #60a5fa;
  }
}

body {
  background: var(--bg);
  color: var(--text);
}
```

### CJK typography

```css
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.8;  /* wider line-height for CJK readability */
}
```

### Responsive layout

```css
.container {
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

@media (max-width: 640px) {
  .container {
    padding: 1rem;
  }
}
```

## Using Templates

Templates are pre-designed HTML files stored in `templates/html/` in the zylos-pages repo. To use a template:

1. Pick the template that matches your content type (see `templates/html/README.md`)
2. Copy its HTML structure
3. Replace placeholder content with your data
4. Save as `.html` in the pages content directory

Templates follow a shared CSS variable system so colors, fonts, and spacing are consistent across all report types.

## Existing HTML Artifacts

Examples of HTML artifacts already in use:

| File | Type | Notable features |
|------|------|-----------------|
| `proposals/dgx-spark-backup-strategy.html` | Technical proposal | Two-column desktop layout, responsive, data classification table |
| `renovation-checklist.html` | Interactive checklist | Collapsible phases, attachment blocks, editable via share links |
