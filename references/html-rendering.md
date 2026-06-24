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
2. **CSP**: HTML artifacts have a separate Content-Security-Policy (`HTML_ARTIFACT_CSP`). Current runtime policy allows inline styles and inline scripts, but only loads scripts/styles/fonts from the same origin.
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
- **Prefer no inline `<script>` tags**: The current HTML artifact CSP allows inline scripts, but external JS under `_assets/` is easier to review and reuse. Avoid remote scripts.
- **Self-contained CSS**: Put all styles in a `<style>` block. Do not depend on external CSS or font hosts; the current CSP does not allow Google Fonts.
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

## Data Visualization

Pages CSP blocks inline `<script>`, so JavaScript charting libraries (Chart.js, D3, etc.) cannot run. All charts must be **pure SVG + CSS** -- no JS required.

The HTML templates in `templates/html/` include ready-to-use SVG chart placeholders. When generating reports, replace the `{{PLACEHOLDER}}` markers with computed values.

### Horizontal Bar Chart

A horizontal bar chart uses SVG `<rect>` elements with variable widths. The bar width is calculated as a percentage of the chart area.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 280" role="img" aria-label="Chart title">
  <!-- Background grid lines -->
  <line x1="160" y1="30" x2="160" y2="250" stroke="var(--border)" stroke-width="1"/>
  <line x1="295" y1="30" x2="295" y2="250" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,4"/>
  <line x1="430" y1="30" x2="430" y2="250" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,4"/>
  <line x1="565" y1="30" x2="565" y2="250" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="4,4"/>
  <line x1="700" y1="30" x2="700" y2="250" stroke="var(--border)" stroke-width="1"/>

  <!-- Axis labels -->
  <text x="160" y="268" fill="var(--text-muted)" font-size="11" text-anchor="middle">0</text>
  <text x="430" y="268" fill="var(--text-muted)" font-size="11" text-anchor="middle">50</text>
  <text x="700" y="268" fill="var(--text-muted)" font-size="11" text-anchor="middle">100</text>

  <!-- Each row: label + background track + colored bar + value -->
  <text x="150" y="56" fill="var(--text)" font-size="13" text-anchor="end" dominant-baseline="middle">Label</text>
  <rect x="160" y="40" width="540" height="28" rx="4" fill="var(--chart-bar-bg)" opacity="0.4"/>
  <rect x="160" y="40" width="459" height="28" rx="4" fill="var(--chart-bar-1)"/>
  <!-- width = score/100 * 540 (chart area is 540px wide) -->
  <text x="625" y="56" fill="var(--text)" font-size="12" font-weight="600" dominant-baseline="middle">85</text>
</svg>
```

**Key formula:** bar width = `(score / 100) * 540` pixels. The chart area spans from x=160 to x=700 (540px). The value text x-position = 160 + bar_width + 6.

### Pie Chart (SVG path arcs)

Pie charts use SVG `<path>` elements with arc commands. Each segment is a "slice" drawn from the center.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <!-- Each segment: path from center to arc -->
  <!-- Segment formula: M cx,cy L startX,startY A r,r 0 large-arc-flag,1 endX,endY Z -->
  <!-- Center: (200, 185), Radius: 140 -->

  <!-- Segment 1: 45% = 162 degrees -->
  <path d="M200,185 L340,185 A140,140 0 0,1 66.85,228.26 Z" fill="var(--chart-pie-blue)"/>

  <!-- Segment 2: 35% = 126 degrees -->
  <path d="M200,185 L66.85,228.26 A140,140 0 0,1 243.26,51.85 Z" fill="var(--chart-pie-purple)"/>

  <!-- Segment 3: 20% = 72 degrees -->
  <path d="M200,185 L243.26,51.85 A140,140 0 0,1 340,185 Z" fill="var(--chart-pie-teal)"/>

  <!-- Percentage labels inside slices -->
  <!-- Position at midpoint angle, ~60% of radius from center -->
  <text x="214" y="274" fill="#ffffff" font-size="16" font-weight="700" text-anchor="middle">45%</text>
</svg>
```

**Coordinate formulas:**
- Degrees per segment = `(percentage / 100) * 360`
- Arc endpoint: `x = cx + r * cos(angle_rad)`, `y = cy + r * sin(angle_rad)`
- Large-arc-flag: `1` if segment > 180 degrees, else `0`
- Label position: use ~60% of radius at the midpoint angle

### Radar / Spider Chart (polygon coordinates)

Radar charts use SVG `<polygon>` elements. Grid rings are concentric pentagons (or diamonds for 4 axes); data values are plotted as vertices of a filled polygon.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <!-- Grid rings (concentric pentagons for 5 dimensions) -->
  <!-- 100% ring (outer boundary) -->
  <polygon points="250,60 421.2,184.4 355.8,385.6 144.2,385.6 78.8,184.4"
    fill="none" stroke="var(--border-strong)" stroke-width="1" />
  <!-- 80% ring -->
  <polygon points="250,96 387,195.5 334.6,356.5 165.4,356.5 113,195.5"
    fill="none" stroke="var(--border)" stroke-width="0.8" />
  <!-- Additional rings at 60%, 40%, 20%... -->

  <!-- Axis lines from center to each vertex -->
  <line x1="250" y1="240" x2="250" y2="60" stroke="var(--border)" stroke-width="0.5" />
  <!-- ... one line per dimension -->

  <!-- Data polygon -->
  <polygon points="250,78 395.5,192.7 343.1,368.1 175.9,341.9 92.5,188.8"
    fill="var(--option-a)" fill-opacity="0.2"
    stroke="var(--option-a)" stroke-width="2" />

  <!-- Data points (dots) at each vertex -->
  <circle cx="250" cy="78" r="4" fill="var(--option-a)" />

  <!-- Dimension labels outside the chart -->
  <text x="250" y="40" text-anchor="middle" fill="var(--text)" font-size="13">Dimension 1</text>
  <text x="250" y="54" text-anchor="middle" fill="var(--text-muted)" font-size="10">90 / 75</text>
</svg>
```

**Coordinate formulas (5-axis pentagon):**
- Center: `(cx, cy)`, max radius: `R`
- Axis angles: `angle_i = -90 + i * 72` degrees (i = 0..4), where -90 puts the first axis at top
- Vertex at score `s` (0-100): `x = cx + (s/100)*R * cos(angle_rad)`, `y = cy + (s/100)*R * sin(angle_rad)`

For a 4-axis diamond, use `angle_i = -90 + i * 90` degrees (i = 0..3).

### Architecture Diagram (rect + line + marker arrows)

Flow diagrams use SVG `<rect>` for boxes and `<line>`/`<path>` with arrowhead markers for connections.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 300" width="700" height="300">
  <!-- Define arrowhead marker -->
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="var(--svg-arrow)" />
    </marker>
  </defs>

  <!-- Background -->
  <rect x="0" y="0" width="700" height="300" rx="8" fill="var(--svg-bg)" />

  <!-- Box -->
  <rect x="255" y="20" width="190" height="52" rx="10"
    fill="var(--svg-box-fill)" stroke="var(--svg-box-stroke)" stroke-width="2" />
  <text x="350" y="42" text-anchor="middle" font-size="15" font-weight="600"
    fill="var(--svg-box-text)">Component Name</text>
  <text x="350" y="60" text-anchor="middle" font-size="11"
    fill="var(--svg-arrow-label)">Subtitle</text>

  <!-- Arrow between boxes -->
  <line x1="350" y1="72" x2="350" y2="148"
    stroke="var(--svg-arrow)" stroke-width="2" marker-end="url(#arrowhead)" />
  <text x="370" y="115" text-anchor="start" font-size="11"
    fill="var(--svg-arrow-label)">action label</text>

  <!-- Feedback loop (dashed path) -->
  <path d="M 255,264 L 30,264 L 30,46 L 253,46" fill="none"
    stroke="var(--svg-arrow)" stroke-width="2" stroke-dasharray="6,3"
    marker-end="url(#arrowhead)" />
</svg>
```

**Tips:**
- Use `rx="10"` on boxes for rounded corners
- Use `stroke-dasharray="6,3"` for dashed feedback/return arrows
- Use `orient="auto"` on markers so arrowheads rotate with line direction

### Timeline / Gantt Chart

Gantt charts use horizontal bars positioned on a time grid.

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 200" width="700" height="200">
  <!-- Background -->
  <rect x="0" y="0" width="700" height="200" rx="8" fill="var(--svg-bg)" />

  <!-- Vertical grid lines (column separators) -->
  <line x1="275" y1="40" x2="275" y2="170" stroke="var(--gantt-grid)" stroke-width="1" />
  <line x1="410" y1="40" x2="410" y2="170" stroke="var(--gantt-grid)" stroke-width="1" />
  <line x1="545" y1="40" x2="545" y2="170" stroke="var(--gantt-grid)" stroke-width="1" />

  <!-- Column header labels -->
  <text x="207" y="30" text-anchor="middle" font-size="12" font-weight="600"
    fill="var(--gantt-text)">W1</text>

  <!-- Phase label (left side) -->
  <text x="130" y="73" text-anchor="end" font-size="13"
    fill="var(--gantt-label)">Phase Name</text>

  <!-- Track background -->
  <rect x="140" y="55" width="540" height="30" rx="4" fill="var(--gantt-track)" />

  <!-- Phase bar -->
  <rect x="140" y="57" width="270" height="26" rx="6"
    fill="var(--gantt-phase1)" opacity="0.9" />
  <text x="275" y="75" text-anchor="middle" font-size="11" font-weight="600"
    fill="#ffffff">Phase 1 (2 weeks)</text>
</svg>
```

**Layout:** The chart area spans x=140 to x=680 (540px). Each column is `540 / num_columns` pixels wide. Bar x-position and width correspond to start/end columns.

### Dark Mode Tips

- **Use CSS custom properties** for all SVG colors: `fill="var(--text)"`, `stroke="var(--border)"`. Define light and dark values in `:root` and `@media (prefers-color-scheme: dark)`.
- **Use `currentColor`** for simple cases where the SVG inherits the parent text color.
- **Never hardcode colors** like `fill="#333"` in SVG elements -- they will be invisible in dark mode. The one exception is white text on colored backgrounds (pie chart labels, Gantt bar labels) which works in both modes.
- **Define chart-specific CSS variables** (e.g. `--chart-bar-1`, `--svg-box-fill`, `--radar-accent`) with both light and dark variants to keep charts visually consistent.

### Responsive Tips

- **Always use `viewBox`** on SVG elements: `viewBox="0 0 700 280"`. This makes the SVG scale to its container without fixed pixel dimensions.
- **Set percentage widths** on containers: wrap SVGs in a div with `width: 100%; overflow-x: auto;`.
- **Use `max-width: 100%; height: auto;`** on the SVG element itself.
- **For pie/radar charts**, set a max-width (e.g. `max-width: 400px; width: 100%;`) to prevent them from becoming too large on wide screens.
- **Add `overflow-x: auto`** on the chart container div so horizontal charts can scroll on narrow screens rather than overflowing.
