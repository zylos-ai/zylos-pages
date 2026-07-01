import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderPage } from '../src/services/renderService.js';

test('markdown renderer adds code block headers, copy controls, and callout tones', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zylos-pages-markdown-ui-'));
  try {
    const sourcePath = path.join(dir, 'ui.md');
    await writeFile(sourcePath, [
      '# UI',
      '',
      '> [!NOTE]',
      '> Keep this visible.',
      '',
      '> [!TIP]',
      '> Use the button.',
      '',
      '> [!WARNING]',
      '> Check the result.',
      '',
      '> [!OK]',
      '> Completed.',
      '',
      '```javascript',
      'const value = 1;',
      '```',
      '',
      '```mermaid',
      'graph TD',
      '```',
    ].join('\n'));

    const rendered = await renderPage(sourcePath, {
      baseUrl: '/pages',
      slug: 'ui',
      renderTimeoutMs: 10_000,
    });

    assert.match(rendered.html, /class="code-block" data-language="javascript"/);
    assert.match(rendered.html, /class="code-block-language">JavaScript<\/span>/);
    assert.match(rendered.html, /class="code-copy-btn" aria-label="Copy JavaScript code">Copy<\/button>/);
    assert.match(rendered.html, /src="\/pages\/_assets\/codeblocks\.js\?v=/);
    assert.match(rendered.html, /class="callout callout-info"/);
    assert.match(rendered.html, /class="callout callout-tip"/);
    assert.match(rendered.html, /class="callout callout-warn"/);
    assert.match(rendered.html, /class="callout callout-ok"/);
    assert.match(rendered.html, /<pre class="mermaid">graph TD\s*<\/pre>/);
    assert.doesNotMatch(rendered.html, /data-language="mermaid"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('viewer CSS protects narrow sticky header and styles code/callout UI', async () => {
  const css = await readFile(new URL('../assets/style.css', import.meta.url), 'utf8');

  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /\.breadcrumb-folder,\s*\.breadcrumb a,\s*\.breadcrumb \.sep\s*\{\s*display: none;/);
  assert.match(css, /\.header-actions\s*\{[\s\S]*?flex-shrink: 0;/);
  assert.match(css, /\.header-left\s*\{[\s\S]*?flex: 1;/);
  assert.match(css, /\.header-actions \.copy-raw-btn,\s*\.header-actions \.theme-toggle,\s*\.header-actions \.logout-btn\s*\{[\s\S]*?width: var\(--control-height\);[\s\S]*?height: var\(--control-height\);[\s\S]*?border-color: transparent;[\s\S]*?background: transparent;/);
  assert.match(css, /\.header-actions \.share-btn\s*\{[\s\S]*?width: var\(--control-height\);[\s\S]*?height: var\(--control-height\);/);
  assert.match(css, /\.markdown-body \.code-block-header/);
  assert.match(css, /\.markdown-body \.code-copy-btn\.is-copied/);
  assert.match(css, /\.markdown-body \.callout-info/);
  assert.match(css, /\.markdown-body \.callout-tip/);
  assert.match(css, /\.markdown-body \.callout-warn/);
  assert.match(css, /\.markdown-body \.callout-ok/);
});

test('code block copy script exposes copied feedback', async () => {
  const script = await readFile(new URL('../assets/codeblocks.js', import.meta.url), 'utf8');

  assert.match(script, /querySelectorAll\('\.code-copy-btn'\)/);
  assert.match(script, /button\.textContent = 'Copied'/);
  assert.match(script, /button\.classList\.add\('is-copied'\)/);
  assert.match(script, /navigator\.clipboard\.writeText/);
});
