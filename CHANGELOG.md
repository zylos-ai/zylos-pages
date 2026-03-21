# Changelog

## [0.1.0] - 2026-03-21

### Added
- Initial release
- Markdown rendering with GFM support (tables, task lists, strikethrough)
- Code syntax highlighting via shiki (VS Code quality)
- YAML frontmatter parsing (title, description, date, tags)
- Auto-generated table of contents for long documents
- Directory index page listing all available pages
- LRU cache with TTL and singleflight dedup
- Content-hash ETag for HTTP caching
- File watcher for automatic cache invalidation
- Dark/light theme with auto-detection and manual toggle
- Security: path traversal protection, HTML sanitization, CSP headers
- Rate limiting and file size limits
- Responsive layout with print stylesheet
- Structured JSON logging for observability
