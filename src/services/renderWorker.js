// Worker thread for isolated markdown rendering with hard timeout capability.
// This runs in a separate thread so the main thread can terminate it on timeout.

import { parentPort, workerData } from 'node:worker_threads';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { createHighlighter } from 'shiki';
import matter from 'gray-matter';
import sanitizeHtml from 'sanitize-html';
import { postProcessMermaid } from '../markdown/mermaid.js';

const { filePath, config } = workerData;

const CALLOUTS = {
  NOTE: {
    tone: 'info',
    label: 'Note',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  },
  TIP: {
    tone: 'tip',
    label: 'Tip',
    icon: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5a5 5 0 1 0-7 0c.8.8 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  },
  WARNING: {
    tone: 'warn',
    label: 'Warning',
    icon: '<path d="m21.7 18-8.5-15a1.4 1.4 0 0 0-2.4 0L2.3 18a1.4 1.4 0 0 0 1.2 2h17a1.4 1.4 0 0 0 1.2-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  },
  CAUTION: {
    tone: 'warn',
    label: 'Warning',
    icon: '<path d="m21.7 18-8.5-15a1.4 1.4 0 0 0-2.4 0L2.3 18a1.4 1.4 0 0 0 1.2 2h17a1.4 1.4 0 0 0 1.2-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  },
  IMPORTANT: {
    tone: 'warn',
    label: 'Important',
    icon: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M5 7.2A8 8 0 0 1 12 3a8 8 0 0 1 7 4.2c.7 1.2.7 2.7 0 3.9L12 21 5 11.1a3.8 3.8 0 0 1 0-3.9Z"/>',
  },
  OK: {
    tone: 'ok',
    label: 'OK',
    icon: '<path d="M20 6 9 17l-5-5"/>',
  },
  SUCCESS: {
    tone: 'ok',
    label: 'Success',
    icon: '<path d="M20 6 9 17l-5-5"/>',
  },
};

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function humanizeLanguage(lang) {
  if (!lang) return 'Text';
  const aliases = { javascript: 'JavaScript', js: 'JavaScript', jsx: 'JSX', typescript: 'TypeScript', ts: 'TypeScript', tsx: 'TSX', py: 'Python', sh: 'Shell', bash: 'Bash', yml: 'YAML', md: 'Markdown' };
  return aliases[lang] || lang.charAt(0).toUpperCase() + lang.slice(1);
}

function codeBlockChrome(attrs, body) {
  const classMatch = attrs.match(/class="[^"]*\blanguage-([^"\s]+)[^"]*"/);
  const lang = classMatch ? classMatch[1].toLowerCase() : 'text';
  const label = humanizeLanguage(lang);
  return `<div class="code-block" data-language="${escapeAttr(lang)}"><div class="code-block-header"><span class="code-block-language">${escapeAttr(label)}</span><button type="button" class="code-copy-btn" aria-label="Copy ${escapeAttr(label)} code">Copy</button></div>${body}</div>`;
}

function enhanceCodeBlocks(html) {
  html = html.replace(/<pre><code([^>]*)>(<pre class="shiki[\s\S]*?<\/pre>)\s*<\/code><\/pre>/g, (_full, attrs, shikiPre) => {
    return codeBlockChrome(attrs, shikiPre);
  });

  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, (full, attrs, inner) => {
    if (/class="mermaid"/.test(full)) return full;
    return codeBlockChrome(attrs, `<pre><code${attrs}>${inner}</code></pre>`);
  });
}

function enhanceCallouts(html) {
  return html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT|OK|SUCCESS)\](?:<br\s*\/?>|\n)([\s\S]*?)<\/p>\s*<\/blockquote>/gi, (_full, type, content) => {
    const spec = CALLOUTS[type.toUpperCase()];
    if (!spec) return _full;
    return `<aside class="callout callout-${spec.tone}"><div class="callout-title"><svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${spec.icon}</svg><span>${spec.label}</span></div><div class="callout-body">${content}</div></aside>`;
  });
}

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
          if (lang === 'mermaid') return code;
          const validLang = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text';
          return highlighter.codeToHtml(code, { lang: validLang, theme: codeTheme });
        } catch {
          return `<pre><code>${code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
        }
      },
    })
  );
  marked.setOptions({ gfm: true, breaks: false });

  const origParse = marked.parse.bind(marked);
  marked.parse = function(src, opts) {
    return postProcessMermaid(origParse(src, opts));
  };

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

  bodyHtml = enhanceCallouts(enhanceCodeBlocks(bodyHtml));

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
