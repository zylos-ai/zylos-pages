// Worker thread for isolated markdown rendering with hard timeout capability.
// This runs in a separate thread so the main thread can terminate it on timeout.

import { parentPort, workerData } from 'node:worker_threads';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { createHighlighter } from 'shiki';
import matter from 'gray-matter';
import sanitizeHtml from 'sanitize-html';

const { filePath, config } = workerData;

async function render() {
  const { readFile, stat } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');

  // Read file with size check
  const stats = await stat(filePath);
  if (stats.size > (config.maxFileSizeBytes || 1048576)) {
    throw new Error(`File too large: ${stats.size} bytes`);
  }
  const raw = await readFile(filePath, 'utf-8');

  // Parse frontmatter
  let fmData = {};
  let markdown = raw;
  try {
    const parsed = matter(raw);
    fmData = parsed.data;
    markdown = parsed.content;
  } catch {
    // treat as pure markdown
  }

  // Escape frontmatter values
  const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => typeof s === 'string' ? s.replace(/[&<>"']/g, c => escMap[c]) : s;
  const meta = {};
  for (const [k, v] of Object.entries(fmData)) {
    if (typeof v === 'string') meta[k] = esc(v);
    else if (Array.isArray(v)) meta[k] = v.map(x => typeof x === 'string' ? esc(x) : x);
    else meta[k] = v;
  }

  // Infer title
  if (!meta.title) {
    const m = markdown.match(/^#\s+(.+)$/m);
    meta.title = m ? esc(m[1].trim()) : 'Untitled';
  }

  // Init shiki highlighter
  const codeTheme = config.codeTheme || 'github-dark';
  const highlighter = await createHighlighter({
    themes: [codeTheme, 'github-light'],
    langs: [
      'javascript', 'typescript', 'python', 'rust', 'go', 'java',
      'json', 'yaml', 'toml', 'html', 'css', 'sql', 'bash', 'shell',
      'markdown', 'c', 'cpp', 'ruby', 'php', 'swift', 'kotlin',
      'dockerfile', 'graphql', 'text',
    ],
  });

  // Configure marked
  const marked = new Marked(
    markedHighlight({
      highlight(code, lang) {
        try {
          const validLang = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text';
          return highlighter.codeToHtml(code, { lang: validLang, theme: codeTheme });
        } catch {
          return `<pre><code>${code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
        }
      },
    })
  );
  marked.setOptions({ gfm: true, breaks: false });

  // Render markdown
  let bodyHtml = await marked.parse(markdown);

  // Sanitize
  const allowRawHtml = config.allowRawHtml || false;
  if (!allowRawHtml) {
    bodyHtml = sanitizeHtml(bodyHtml, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([
        'img', 'details', 'summary', 'pre', 'code', 'span',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'input', 'del', 's', 'sup', 'sub', 'hr',
      ]),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        code: ['class'], span: ['class', 'style'], pre: ['class', 'style'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        input: ['type', 'checked', 'disabled'],
        th: ['align'], td: ['align'],
        a: ['href', 'title', 'target', 'rel'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
    });
  }

  // Strip leading H1 only if its text matches the frontmatter title (avoid duplicate)
  if (meta.title) {
    const h1Match = bodyHtml.match(/^\s*<h1[^>]*>(.*?)<\/h1>/i);
    if (h1Match) {
      const h1Text = h1Match[1].replace(/<[^>]+>/g, '').trim();
      const titleText = meta.title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      if (h1Text === titleText) {
        bodyHtml = bodyHtml.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/i, '');
      }
    }
  }

  // Wrap tables in scrollable container for mobile
  bodyHtml = bodyHtml.replace(
    /<table>/g,
    '<div class="table-wrapper"><table>'
  ).replace(
    /<\/table>/g,
    '</table></div>'
  );

  // Inject heading IDs
  bodyHtml = bodyHtml.replace(
    /<h([23])(\s*>)(.*?)<\/h[23]>/gi,
    (full, level, rest, content) => {
      const text = content.replace(/<[^>]+>/g, '').trim();
      const id = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      return `<h${level} id="${id}"${rest}${content}</h${level}>`;
    }
  );

  // Extract TOC
  const tocItems = [];
  const headingRegex = /<h([23])\s*(?:id="([^"]*)")?\s*>(.*?)<\/h[23]>/gi;
  let match;
  while ((match = headingRegex.exec(bodyHtml)) !== null) {
    tocItems.push({
      level: parseInt(match[1], 10),
      id: match[2] || '',
      text: match[3].replace(/<[^>]+>/g, '').trim(),
    });
  }

  // Generate ETag
  const etag = '"' + createHash('sha256').update(bodyHtml).digest('hex').slice(0, 32) + '"';

  return { bodyHtml, meta, tocItems, etag, size: stats.size };
}

render()
  .then(result => parentPort.postMessage({ ok: true, result }))
  .catch(err => parentPort.postMessage({ ok: false, error: err.message, code: err.code }));
