import test from 'node:test';
import assert from 'node:assert/strict';
import { injectAnnotations, injectAnnotationReporter } from '../src/templates/annotations.js';

const shell = '<!doctype html><html><head><title>Test</title></head><body><article>Content</article></body></html>';
const options = { baseUrl: '/pages', pageId: 'stable-page', uri: 'docs/test' };

test('owner metadata uses stable page identity and trusted canonical mount path', () => {
  const html = injectAnnotations(shell, options);
  assert.match(html, /data-base-namespace="\/pages"/);
  assert.match(html, /data-page-id="stable-page"/);
  assert.match(html, /data-viewer-scope="owner"/);
  assert.match(html, /data-document-url="\/pages\/p\/docs\/test"/);
  assert.match(html, /<script src="\/pages\/_assets\/annotations-core\.js\?v=\d+" defer><\/script>/);
  assert.ok(html.indexOf('annotations-core.js') < html.indexOf('annotations.js'));
  assert.ok(html.includes('<article>Content</article>'));
});

test('share metadata has nonsecret distinct scopes and exports no bearer link', () => {
  const first = injectAnnotations(shell, { ...options, share: { tokenId: 'test-secret-token-one' } });
  const second = injectAnnotations(shell, { ...options, share: { tokenId: 'test-secret-token-two' } });
  assert.equal(first.includes('test-secret-token-one'), false);
  assert.equal(second.includes('test-secret-token-two'), false);
  assert.match(first, /data-document-url=""/);
  const scope = html => html.match(/data-viewer-scope="([^"]+)"/)[1];
  assert.match(scope(first), /^share-[0-9a-f]{64}$/);
  assert.notEqual(scope(first), scope(second));
  assert.equal(scope(first), scope(injectAnnotations(shell, { ...options, share: { tokenId: 'test-secret-token-one' } })));
});

test('metadata attribute escapes unsafe characters and legacy identity falls back to URI', () => {
  const html = injectAnnotations(shell, { ...options, pageId: 'page"<&\'>' });
  assert.match(html, /data-page-id="page&quot;&lt;&amp;&#39;&gt;"/);
  assert.equal(html.includes('data-page-id="page"<'), false);
  const legacy = injectAnnotations(shell, { ...options, pageId: undefined });
  assert.match(legacy, /data-page-id="docs\/test"/);
});

test('disabled annotations retain an explicit unavailable shell without an artifact reporter', () => {
  const html = injectAnnotations(shell, { ...options, enabled: false });
  assert.match(html, /data-unavailable="true"/);
  assert.equal(html.includes('annotations-core.js'), true);
  assert.equal(html.includes('annotations.js'), true);
  assert.equal(html.includes('annotations-frame.js'), false);
  assert.match(injectAnnotations(shell, options), /data-unavailable="false"/);
});

test('reporter loads core before the deferred reporter without capability bridge dependencies', () => {
  const html = injectAnnotationReporter(shell, '/pages');
  assert.ok(html.indexOf('annotations-core.js') < html.indexOf('annotations-frame.js'));
  assert.match(html, /annotations-frame\.js\?v=\d+" defer/);
  assert.equal(html.includes('bridge-client.js'), false);
  const noHead = injectAnnotationReporter('<p>HTML fragment</p>', '/pages');
  assert.match(noHead, /^<script src="\/pages\/_assets\/annotations-core\.js/);
  assert.ok(noHead.endsWith('<p>HTML fragment</p>'));
});
