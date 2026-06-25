# HTML Report Templates

Pre-designed templates for generating styled HTML reports. Each template is standalone: copy the HTML, replace `{{PLACEHOLDER}}` values with your content, and save as `.html` in the pages content directory.

The layouts are adapted from common open-source report patterns: executive summaries, comparison matrices, status banners, metric cards, and interview evaluation grids. Do not paste third-party HTML/CSS directly into generated reports unless the license has been checked.

## Available Templates

| Template | Use Case | Accent Color |
|----------|----------|-------------|
| `research-report.html` | Research reports, deep analysis, investigation findings | Blue |
| `technical-proposal.html` | Technical proposals, architecture documents, design specs | Purple |
| `comparison.html` | A vs B comparisons, competitive analysis, feature matrices | Teal |
| `evaluation.html` | Interview evaluations, candidate assessments, review reports | Teal-green |
| `interview-questions.html` | Interview question guides with hypotheses, pacing, and judgment framework | Blue |

## Shared Design System

All templates share a common design token system defined in `base.css`:

- **Typography**: System font stack with CJK support (Noto Sans SC, PingFang SC, Microsoft YaHei)
- **Colors**: Semantic tokens (`--bg`, `--text`, `--accent`, `--success`, `--warning`, `--error`)
- **Dark mode**: Automatic via `prefers-color-scheme: dark`
- **Spacing**: 4px base grid (`--space-1` through `--space-16`)
- **Responsive**: Mobile-first with 640px breakpoint
- **Print**: Clean print stylesheet included

Each template embeds the tokens inline (no external dependency). `base.css` is the canonical reference — when updating tokens, propagate to all templates.

## Usage

### For agents

When generating an HTML report, pick the matching template and replace placeholders:

```
1. Read the template file
2. Replace all {{PLACEHOLDER}} values with actual content
3. Add/remove sections as needed (templates are starting points, not rigid)
4. Write to ~/zylos/http/public/pages/<path>.html
```

### Customizing

- **Add sections**: Copy an existing `<section>` block and modify
- **Change accent color**: Override `--accent`, `--accent-light`, `--accent-text` in `:root`
- **Add components**: Use utility classes from base.css (`.card`, `.badge`, `.callout`, `.stat-grid`)

## Design Principles

1. **Content first** - templates maximize reading area, minimize chrome
2. **Information density** - tables, score bars, and cards pack data efficiently
3. **CJK-ready** - line-height 1.75, font stack with Chinese fallbacks
4. **No dependencies** - everything in one HTML file, no build step
5. **Progressive** - works without JS, dark mode via CSS media query
