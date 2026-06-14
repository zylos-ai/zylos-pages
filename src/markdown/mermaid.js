// Mermaid post-processing: convert <pre><code class="language-mermaid"> to <pre class="mermaid">
// Used by both parser.js and renderWorker.js.
// Entities are kept escaped — the browser decodes them via textContent when
// Mermaid reads the element client-side. Decoding server-side would turn
// mermaid source text into real HTML before the sanitizer runs.

export function postProcessMermaid(html) {
  return html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (_m, inner) => {
    return `<pre class="mermaid">${inner}</pre>`;
  });
}
