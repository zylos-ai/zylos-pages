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

test('trusted shell bridge enforces pending limits and reconnects after iframe load', async () => {
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
    dataset: { bridgeEndpoint: '/api/bridge/page-id' },
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

  const announceReady = () => windowListeners.get('message')({
    source: childWindow,
    data: { type: 'zylos-pages:bridge-ready' },
  });
  announceReady();
  const responses = [];
  childPort.onmessage = ({ data }) => responses.push(data);
  for (let index = 0; index < 17; index += 1) {
    childPort.postMessage({ id: String(index), operation: 'state.get', input: { key: String(index) } });
  }
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, 'too_many_pending');
  releaseFetch();
  await flush();
  assert.equal(calls.length, 16);
  assert.equal(responses.length, 17);

  let probe = null;
  childWindow.postMessage = message => { probe = message; };
  iframeListeners.get('load')();
  assert.equal(probe.type, 'zylos-pages:bridge-probe');
  childWindow.postMessage = (message, _target, ports = []) => {
    if (message.type === 'zylos-pages:bridge-port') childPort = ports[0];
  };
  announceReady();
  const reconnected = [];
  childPort.onmessage = ({ data }) => reconnected.push(data);
  childPort.postMessage({ id: 'reload', operation: 'state.get', input: { key: 'reload' } });
  await flush();
  assert.equal(reconnected.length, 1);
  assert.equal(reconnected[0].id, 'reload');
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
