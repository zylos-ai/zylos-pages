import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../assets/annotations-frame.js', import.meta.url), 'utf8');

function fixture() {
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let scrolls = 0;
  const parent = { postMessage() {} };
  const range = {
    startContainer: { nodeType: 1, scrollIntoView() { scrolls++; } },
    getClientRects: () => [{ left: 10, right: 80, top: 20, bottom: 40 }]
  };
  const selection = { isCollapsed: true, removeAllRanges() {} };
  const core = {
    LIMITS: { records: 200 },
    buildTextIndex: () => ({}),
    selectionAnchor: () => null,
    validateAnchor: anchor => anchor?.valid === true,
    rangeForAnchor: (_index, anchor) => anchor.found ? range : null
  };
  const window = {
    parent, PagesAnnotationsCore: core,
    CSS: { highlights: new Map() }, Highlight: class {},
    addEventListener: (name, listener) => listeners.set(name, listener),
    getSelection: () => selection
  };
  const document = {
    body: {}, head: { appendChild() {} }, documentElement: {},
    createElement: () => ({ dataset: {} }),
    addEventListener: (name, listener) => listeners.set(`document:${name}`, listener)
  };
  vm.runInNewContext(source, {
    window, document,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  function port() {
    return { messages: [], closed: false, postMessage(message) { this.messages.push(message); }, start() {}, close() { this.closed = true; } };
  }
  function init(target, generation = 'one', source = parent) {
    listeners.get('message')({ source, data: { type: 'pages-annotations:init', version: 1, generation }, ports: [target] });
  }
  function send(target, data) { target.onmessage?.({ data: { version: 1, generation: 'one', ...data } }); }
  function flush() {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(callback => callback());
  }
  return { port, init, send, flush, listeners, selection, scrolls: () => scrolls };
}

test('frame only accepts a parent handshake with bounded generation', () => {
  const f = fixture();
  const port = f.port();
  f.init(port, 'one', {});
  f.init(port, 'x'.repeat(101));
  assert.equal(port.onmessage, undefined);
  f.init(port);
  assert.equal(port.messages[0].type, 'ready');
});

test('persisted page restore accepts a fresh handshake and rejects the old port', () => {
  const f = fixture();
  const first = f.port();
  f.init(first);
  f.listeners.get('pagehide')({ persisted: true });
  assert.equal(first.closed, true);
  f.listeners.get('pageshow')({ persisted: true });
  const restored = f.port();
  f.init(restored);
  assert.equal(restored.messages[0].type, 'ready');
  f.send(first, { type: 'anchors', items: [{ id: 'old', anchor: { valid: true, found: true } }] });
  f.send(restored, { type: 'anchors', items: [{ id: 'new', anchor: { valid: true, found: true } }] });
  f.flush();
  assert.equal(JSON.stringify(restored.messages.find(message => message.type === 'locations').items), JSON.stringify([{ id: 'new', status: 'matched' }]));
  f.listeners.get('pagehide')({ persisted: true });
  assert.equal(restored.closed, true);
});

test('click reports all overlapping matched IDs only for collapsed selection', () => {
  const f = fixture();
  const port = f.port();
  f.init(port);
  f.send(port, { type: 'anchors', items: ['a', 'b'].map(id => ({ id, anchor: { valid: true, found: true } })) });
  f.flush();
  const click = f.listeners.get('document:click');
  click({ button: 0, clientX: 30, clientY: 30 });
  assert.equal(JSON.stringify(port.messages.find(message => message.type === 'activate').ids), JSON.stringify(['a', 'b']));
  const count = port.messages.length;
  click({ button: 0, clientX: 100, clientY: 100 });
  f.selection.isCollapsed = false;
  click({ button: 0, clientX: 30, clientY: 30 });
  assert.equal(port.messages.length, count);
});

test('frame resolves bounded valid anchors and rejects malformed or stale requests', () => {
  const f = fixture();
  const port = f.port();
  f.init(port);
  f.flush();
  f.send(port, { type: 'anchors', items: [{ id: 'a', anchor: { valid: true, found: true } }, { id: 'b', anchor: { valid: true } }] });
  f.flush();
  const locations = port.messages.find(message => message.type === 'locations');
  assert.equal(JSON.stringify(locations.items), JSON.stringify([{ id: 'a', status: 'matched' }, { id: 'b', status: 'unmatched' }]));
  f.send(port, { type: 'locate', id: 'a', generation: 'stale' });
  f.send(port, { type: 'locate', id: 'unknown' });
  assert.equal(f.scrolls(), 0);
  f.send(port, { type: 'locate', id: 'a' });
  assert.equal(f.scrolls(), 1);
  const before = port.messages.length;
  f.send(port, { type: 'anchors', items: [{ id: 'bad', anchor: {} }] });
  f.send(port, { type: 'anchors', items: new Array(201).fill({ id: 'a', anchor: { valid: true } }) });
  f.flush();
  assert.equal(port.messages.slice(before).some(message => message.items?.some(item => item.id === 'bad')), false);
});

test('replaced ports and pagehide cannot report or locate', () => {
  const f = fixture();
  const first = f.port();
  f.init(first);
  const second = f.port();
  f.init(second, 'two');
  assert.equal(first.closed, true);
  f.send(first, { type: 'anchors', items: [{ id: 'a', anchor: { valid: true, found: true } }] });
  f.flush();
  assert.equal(first.messages.some(message => message.type === 'locations'), false);
  f.listeners.get('pagehide')();
  assert.equal(second.closed, true);
  const third = f.port();
  f.init(third);
  assert.equal(third.onmessage, undefined);
});
