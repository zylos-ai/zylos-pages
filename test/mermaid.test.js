import assert from 'node:assert/strict';
import test from 'node:test';
import { postProcessMermaid } from '../src/markdown/mermaid.js';

test('mermaid code fence produces <pre class="mermaid">', () => {
  const input = '<pre><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>';
  const result = postProcessMermaid(input);
  assert.match(result, /<pre class="mermaid">/);
  assert.doesNotMatch(result, /<code/);
});

test('mermaid source with HTML-like text is not decoded into real tags', () => {
  const input = '<pre><code class="language-mermaid">A[&lt;img src=x onerror=alert(1)&gt;]</code></pre>';
  const result = postProcessMermaid(input);
  assert.doesNotMatch(result, /<img/);
  assert.match(result, /&lt;img/);
});

test('mermaid source with script-like text is preserved verbatim', () => {
  const input = '<pre><code class="language-mermaid">A[&lt;script&gt;alert(1)&lt;/script&gt;]</code></pre>';
  const result = postProcessMermaid(input);
  assert.doesNotMatch(result, /<script/);
  assert.match(result, /&lt;script&gt;/);
});

test('non-mermaid content is not affected', () => {
  const input = '<pre><code class="language-javascript">const x = 1;</code></pre>';
  const result = postProcessMermaid(input);
  assert.equal(result, input);
});

test('page template includes mermaid scripts only when mermaid blocks present', async () => {
  const { pageTemplate } = await import('../src/templates/pageTemplate.js');

  const withMermaid = pageTemplate({
    title: 'Test', description: '', date: '', tags: [],
    bodyHtml: '<pre class="mermaid">graph TD</pre>',
    tocItems: [], baseUrl: '', slug: 'test',
  });
  assert.match(withMermaid, /mermaid\.min\.js/);
  assert.match(withMermaid, /mermaid-init\.js/);
  assert.match(withMermaid, /mermaid-zoom\.js/);

  const withoutMermaid = pageTemplate({
    title: 'Test', description: '', date: '', tags: [],
    bodyHtml: '<p>No diagrams here</p>',
    tocItems: [], baseUrl: '', slug: 'test2',
  });
  assert.doesNotMatch(withoutMermaid, /mermaid\.min\.js/);
  assert.doesNotMatch(withoutMermaid, /mermaid-init\.js/);
  assert.doesNotMatch(withoutMermaid, /mermaid-zoom\.js/);
});
