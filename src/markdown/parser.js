// Markdown parser configuration (P0-2)

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import { postProcessMermaid } from './mermaid.js';

let highlighterInstance = null;

/**
 * Create a configured Marked instance with GFM and syntax highlighting.
 * @param {object} highlighter - shiki highlighter instance
 * @param {object} options - { allowRawHtml, codeTheme }
 */
export function createParser(highlighter, options = {}) {
  highlighterInstance = highlighter;
  const { codeTheme = 'github-dark' } = options;

  const marked = new Marked(
    markedHighlight({
      highlight(code, lang) {
        try {
          if (lang === 'mermaid') return code;
          if (!highlighterInstance) {
            return code;
          }
          const validLang = highlighterInstance.getLoadedLanguages().includes(lang) ? lang : 'text';
          return highlighterInstance.codeToHtml(code, {
            lang: validLang,
            theme: codeTheme,
          });
        } catch {
          // P0-2: graceful degradation on highlight failure
          return `<pre><code>${escapeCodeBlock(code)}</code></pre>`;
        }
      },
    })
  );

  marked.setOptions({
    gfm: true,
    breaks: false,
  });

  const origParse = marked.parse.bind(marked);
  marked.parse = function(src, opts) {
    return postProcessMermaid(origParse(src, opts));
  };

  return marked;
}

function escapeCodeBlock(code) {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
