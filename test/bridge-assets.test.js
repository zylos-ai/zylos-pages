import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

class FakePort {
  onmessage = null;
  peer = null;
  closed = false;

  postMessage(data) {
    if (this.closed || this.peer?.closed) return;
    queueMicrotask(() => this.peer?.onmessage?.({ data }));
  }

  start() {}

  close() {
    this.closed = true;
  }
}

class FakeMessageChannel {
  constructor() {
    this.port1 = new FakePort();
    this.port2 = new FakePort();
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function createShellBridge({ outboundDenied = false, userActive = true, locationHash = '' } = {}) {
  const source = await readFile(new URL('../assets/bridge.js', import.meta.url), 'utf8');
  const windowListeners = new Map();
  const iframeListeners = new Map();
  let childPort = null;
  const childWindow = {
    postMessage(message, _target, ports = []) {
      if (message.type === 'zylos-pages:bridge-port') childPort = ports[0];
    },
  };
  const iframe = {
    dataset: {
      bridgeEndpoint: '/api/bridge/page-id',
      bridgeSrc: '/p/current?raw=1',
      pageOpenBase: '/current',
      pageOpenPaths: JSON.stringify(['/p/current', '/current', '/p/other', '/other', '/p/\u62a5\u544a', '/\u62a5\u544a']),
      outboundDenied: String(outboundDenied),
    },
    contentWindow: childWindow,
    addEventListener(type, listener) { iframeListeners.set(type, listener); },
  };
  const assigned = [];
  const opened = [];
  const forwarded = [];
  const activation = { isActive: userActive };
  const location = {
    href: 'https://pages.example.test/p/current',
    origin: 'https://pages.example.test',
    hash: locationHash,
    assign(href) { assigned.push(href); },
  };
  const window = {
    location,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    open(...args) { opened.push(args); },
  };
  vm.runInNewContext(source, {
    document: { querySelector: () => iframe },
    window,
    navigator: { userActivation: activation },
    MessageChannel: FakeMessageChannel,
    URL,
    Set,
    JSON,
    Object,
    Array,
    fetch: async (endpoint, options) => {
      forwarded.push({ endpoint, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: true, result: { forwarded: true } }) };
    },
  });
  iframeListeners.get('load')();
  windowListeners.get('message')({
    source: childWindow,
    data: { type: 'zylos-pages:bridge-ready' },
  });

  let sequence = 0;
  const request = async (operation, input) => {
    const id = String(++sequence);
    const response = new Promise(resolve => {
      childPort.onmessage = event => {
        if (event.data.id === id) resolve(event.data);
      };
    });
    childPort.postMessage({ id, operation, input });
    await flush();
    return response;
  };
  return { activation, assigned, iframe, opened, forwarded, request };
}

test('trusted shell bridge provisions once, preserves concurrency accounting, and revokes on navigation', async () => {
  const source = await readFile(new URL('../assets/bridge.js', import.meta.url), 'utf8');
  const windowListeners = new Map();
  const iframeListeners = new Map();
  let childPort = null;
  const childWindow = {
    postMessage(message, _target, ports = []) {
      if (message.type === 'zylos-pages:bridge-port') childPort = ports[0];
    },
  };
  const iframe = {
    dataset: {
      bridgeEndpoint: '/api/bridge/page-id',
      bridgeSrc: '/p/expected?raw=1',
      pageOpenBase: '/expected',
      pageOpenPaths: '[]',
    },
    contentWindow: childWindow,
    addEventListener(type, listener) { iframeListeners.set(type, listener); },
  };
  const calls = [];
  let releaseFetch;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  const context = {
    document: { querySelector: () => iframe },
    window: {
      location: { href: 'https://pages.example.test/expected', origin: 'https://pages.example.test', hash: '' },
      addEventListener(type, listener) { windowListeners.set(type, listener); },
    },
    URL,
    Set,
    JSON,
    Object,
    Array,
    MessageChannel: FakeMessageChannel,
    fetch: async (endpoint, options) => {
      calls.push({ endpoint, body: JSON.parse(options.body) });
      await fetchGate;
      return { json: async () => ({ ok: true, result: { operation: calls.at(-1).body.operation } }) };
    },
  };
  vm.runInNewContext(source, context);
  assert.equal(iframe.src, '/p/expected?raw=1');

  const announceReady = () => windowListeners.get('message')({
    source: childWindow,
    data: { type: 'zylos-pages:bridge-ready' },
  });
  iframeListeners.get('load')();
  announceReady();
  const originalPort = childPort;
  const responses = [];
  childPort.onmessage = ({ data }) => responses.push(data);
  for (let index = 0; index < 17; index += 1) {
    childPort.postMessage({ id: String(index), operation: 'state.get', input: { key: String(index) } });
  }
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, 'too_many_pending');
  announceReady();
  assert.equal(childPort, originalPort, 'repeated ready must not replace the live port or reset active calls');
  assert.equal(calls.length, 4);
  releaseFetch();
  await flush();
  assert.equal(calls.length, 16);
  assert.equal(responses.length, 17);

  const expiredPort = childPort;
  iframeListeners.get('load')();
  assert.equal(expiredPort.peer.closed, true);
  childWindow.postMessage = (message, _target, ports = []) => {
    if (message.type === 'zylos-pages:bridge-port') childPort = ports[0];
  };
  announceReady();
  assert.equal(childPort, expiredPort, 'a navigated document must never receive a replacement port');
});

test('trusted shell handles page.open locally and allows only registered same-site views', async () => {
  const bridge = await createShellBridge();

  let response = await bridge.request('page.open', { href: '/p/other#details' });
  assert.equal(response.ok, true);
  assert.deepEqual(bridge.assigned, ['https://pages.example.test/p/other#details']);
  assert.equal(bridge.forwarded.length, 0, 'page.open must never reach the server bridge endpoint');

  response = await bridge.request('page.open', { href: '/p/%E6%8A%A5%E5%91%8A#details' });
  assert.equal(response.ok, true);
  assert.equal(bridge.assigned[1], 'https://pages.example.test/p/%E6%8A%A5%E5%91%8A#details');

  response = await bridge.request('page.open', { href: '/other#legacy' });
  assert.equal(response.ok, true);
  assert.equal(bridge.assigned[2], 'https://pages.example.test/other#legacy');

  response = await bridge.request('page.open', { href: 'other#relative' });
  assert.equal(response.ok, true);
  assert.equal(bridge.assigned[3], 'https://pages.example.test/other#relative');

  const rejected = [
    ['/p/other?', 'navigation_denied'],
    ['/p/other?#details', 'navigation_denied'],
    ['/p/other?raw=1', 'navigation_denied'],
    ['/p/unregistered', 'navigation_denied'],
    ['/api/bridge/page-id', 'navigation_denied'],
    ['/_assets/bridge.js', 'navigation_denied'],
    ['/admin', 'navigation_denied'],
    ['/s/token', 'navigation_denied'],
    ['/handoff/token', 'navigation_denied'],
    ['https://user:secret@pages.example.test/p/other', 'navigation_denied'],
    ['https://user:secret@example.net/path', 'navigation_denied'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['data:text/html,hello', 'unsupported_scheme'],
    ['blob:https://pages.example.test/id', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
  ];
  for (const [href, code] of rejected) {
    response = await bridge.request('page.open', { href });
    assert.equal(response.error.code, code, href);
  }

  response = await bridge.request('page.open', { href: 'https://example.net/path?q=1#section' });
  assert.equal(response.ok, true);
  assert.deepEqual(bridge.opened, [[
    'https://example.net/path?q=1#section',
    '_blank',
    'noopener,noreferrer',
  ]]);

  response = await bridge.request('state.get', { key: 'unchanged' });
  assert.equal(response.ok, true);
  assert.deepEqual(bridge.forwarded, [{
    endpoint: '/api/bridge/page-id',
    body: { operation: 'state.get', input: { key: 'unchanged' } },
  }]);
});

test('trusted shell requires activation and enforces per-page outbound denial', async () => {
  const inactive = await createShellBridge({ userActive: false });
  let response = await inactive.request('page.open', { href: '/p/other' });
  assert.equal(response.error.code, 'user_activation_required');
  assert.deepEqual(inactive.assigned, []);
  inactive.activation.isActive = true;
  response = await inactive.request('page.open', { href: '/p/other' });
  assert.equal(response.ok, true);

  const denied = await createShellBridge({ outboundDenied: true });
  response = await denied.request('page.open', { href: 'https://example.net/path' });
  assert.equal(response.error.code, 'outbound_denied');
  assert.deepEqual(denied.opened, []);

  response = await denied.request('page.open', { href: 42 });
  assert.equal(response.error.code, 'invalid_request');
});

test('trusted shell propagates the page fragment into the raw iframe URL', async () => {
  const bridge = await createShellBridge({ locationHash: '#details' });
  assert.equal(bridge.assigned.length, 0);
  assert.equal(bridge.iframe.src, '/p/current?raw=1#details');
});

test('sandbox bridge client re-announces readiness when the trusted shell probes', async () => {
  const source = await readFile(new URL('../assets/bridge-client.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const announcements = [];
  const parent = { postMessage(message) { announcements.push(message); } };
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent() {},
  };
  const document = { addEventListener() {} };
  vm.runInNewContext(source, {
    window,
    document,
    parent,
    CustomEvent: class CustomEvent {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout() {},
    Date,
    Error,
    Object,
    Promise,
  });
  assert.equal(announcements.length, 1);
  listeners.get('message')({ source: parent, data: { type: 'zylos-pages:bridge-probe' }, ports: [] });
  assert.equal(announcements.length, 2);
  assert.equal(announcements[1].type, 'zylos-pages:bridge-ready');
});

test('sandbox bridge client intercepts only unmodified primary cross-page clicks', async () => {
  const source = await readFile(new URL('../assets/bridge-client.js', import.meta.url), 'utf8');
  const windowListeners = new Map();
  const documentListeners = new Map();
  const parent = { postMessage() {} };
  const warnings = [];
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    dispatchEvent() {},
  };
  vm.runInNewContext(source, {
    window,
    document: { addEventListener(type, listener) { documentListeners.set(type, listener); } },
    parent,
    CustomEvent: class CustomEvent {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout() {},
    Date,
    Error,
    Object,
    Promise,
    Map,
    console: { warn: (...args) => warnings.push(args) },
  });

  const channel = new FakeMessageChannel();
  const requests = [];
  channel.port1.onmessage = ({ data }) => {
    requests.push(data);
    channel.port1.postMessage({ id: data.id, ok: true, result: { ok: true } });
  };
  windowListeners.get('message')({
    source: parent,
    data: { type: 'zylos-pages:bridge-port' },
    ports: [channel.port2],
  });

  const click = documentListeners.get('click');
  const anchor = {
    href: 'https://pages.example.test/p/other#details',
    getAttribute: () => '/p/other#details',
    hasAttribute: () => false,
  };
  const ordinary = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { closest: () => anchor },
    preventDefault() { this.prevented = true; },
  };
  click(ordinary);
  await flush();
  assert.equal(ordinary.prevented, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'page.open');
  assert.equal(requests[0].input.href, '/p/other#details');

  channel.port1.onmessage = ({ data }) => {
    requests.push(data);
    channel.port1.postMessage({
      id: data.id,
      ok: false,
      error: { code: 'navigation_denied', message: 'same-site target is not a registered page view' },
    });
  };
  const denied = {
    ...ordinary,
    prevented: false,
    target: { closest: () => ({
      ...anchor,
      href: 'https://pages.example.test/p/denied',
      getAttribute: () => '/p/denied',
    }) },
  };
  click(denied);
  await flush();
  assert.equal(denied.prevented, true);
  assert.deepEqual(warnings, [['[zylos-pages] page.open rejected', 'navigation_denied']]);

  const exceptions = [
    { defaultPrevented: true },
    { button: 1 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { anchor: null },
    { download: true },
    { rawHref: '#section' },
    { rawHref: '' },
  ];
  for (const exception of exceptions) {
    const currentAnchor = exception.anchor === null ? null : {
      ...anchor,
      getAttribute: () => exception.rawHref ?? '/p/other',
      hasAttribute: name => name === 'download' && exception.download === true,
    };
    const event = {
      ...ordinary,
      prevented: false,
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...exception,
      target: { closest: () => currentAnchor },
    };
    click(event);
    assert.equal(event.prevented, false, JSON.stringify(exception));
  }
  await flush();
  assert.equal(requests.length, 2);
});
