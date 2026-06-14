// Mermaid post-processing: convert <pre><code class="language-mermaid"> to <pre class="mermaid">
// Used by both parser.js and renderWorker.js.

export function postProcessMermaid(html) {
  return html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_m, inner) => {
    const code = inner.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    return `<pre class="mermaid">${code}</pre>`;
  });
}
