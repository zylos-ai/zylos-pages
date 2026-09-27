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
    dataset: { bridgeEndpoint: '/api/bridge/page-id', bridgeSrc: '/p/expected?raw=1' },
    contentWindow: childWindow,
    addEventListener(type, listener) { iframeListeners.set(type, listener); },
  };
  const calls = [];
  let releaseFetch;
  const fetchGate = new Promise(resolve => { releaseFetch = resolve; });
  const context = {
    document: { querySelector: () => iframe },
    window: { addEventListener(type, listener) { windowListeners.set(type, listener); } },
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

test('sandbox bridge client re-announces readiness when the trusted shell probes', async () => {
  const source = await readFile(new URL('../assets/bridge-client.js', import.meta.url), 'utf8');
  const listeners = new Map();
  const announcements = [];
  const parent = { postMessage(message) { announcements.push(message); } };
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent() {},
  };
  vm.runInNewContext(source, {
    window,
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
