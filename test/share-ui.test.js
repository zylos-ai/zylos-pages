import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const shareScript = fs.readFileSync(new URL('../assets/share.js', import.meta.url), 'utf8');

test('page share modal active share rows include copy-link controls backed by shortUrl', () => {
  assert.match(shareScript, /class="share-copy-btn share-item-copy-btn"/);
  assert.match(shareScript, /data-short-url="' \+ escapeAttr\(s\.shortUrl\) \+ '"/);
  assert.match(shareScript, /querySelectorAll\('\.share-item-copy-btn'\)/);
  assert.match(shareScript, /copyText\(btn\.dataset\.shortUrl, btn, 'Copy link'\)/);
});

test('page share modal escapes active share copy-link attributes', () => {
  assert.match(shareScript, /function escapeAttr\(value\)/);
  assert.match(shareScript, /replace\(\/&\/g, '&amp;'\)/);
  assert.match(shareScript, /replace\(\/"\/g, '&quot;'\)/);
});
