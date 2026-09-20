import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR } from '../lib/config.js';
import { handoffStore } from './handoff-store.js';

export const HANDOFF_CONTROL_SOCKET = path.join(DATA_DIR, 'handoff-control.sock');
export const HANDOFF_CONTROL_REQUEST_LIMIT_BYTES = 8192;

function publicBase(config) {
  const configured = config.publicBaseUrl || '/pages';
  return String(configured).replace(/\/+$/, '');
}

async function removeStaleSocket(socketPath) {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`Refusing to replace non-socket control path: ${socketPath}`);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const active = await new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', err => {
      if (err.code === 'ECONNREFUSED') resolve(false);
      else reject(err);
    });
  });
  if (active) throw Object.assign(new Error('Handoff control socket is already active'), { code: 'EADDRINUSE' });
  fs.unlinkSync(socketPath);
}

function safeError(err) {
  const allowed = new Set([
    'aborted', 'consumed', 'expired', 'invalid_label', 'invalid_ttl',
    'invalid_value', 'not_found', 'revoked', 'unavailable', 'value_too_large',
    'viewed', 'waiting',
  ]);
  const code = allowed.has(err?.code) ? err.code : 'invalid_request';
  return { ok: false, error: code };
}

function send(socket, response) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

async function dispatch(request, socket, store, config, abortController) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw Object.assign(new Error('Invalid request'), { code: 'invalid_request' });
  }
  const { operation, id, manageToken } = request;
  switch (operation) {
    case 'create': {
      const created = store.create({ ttlMs: request.ttlMs, label: request.label });
      return {
        ok: true,
        ...created,
        submitUrl: `${publicBase(config)}/handoff/${created.id}`,
      };
    }
    case 'create_reveal': {
      const created = store.createReveal({ value: request.value, ttlMs: request.ttlMs, label: request.label });
      return {
        ok: true,
        ...created,
        revealUrl: `${publicBase(config)}/handoff/${created.id}`,
      };
    }
    case 'status':
      return { ok: true, ...store.status(id, manageToken) };
    case 'consume':
      return { ok: true, value: store.consume(id, manageToken) };
    case 'await':
      return {
        ok: true,
        value: await store.awaitAndConsume(id, manageToken, { signal: abortController.signal }),
      };
    case 'await_viewed':
      return {
        ok: true,
        event: await store.awaitViewed(id, manageToken, { signal: abortController.signal }),
      };
    case 'revoke':
      return { ok: true, revoked: store.revoke(id, manageToken) };
    default:
      throw Object.assign(new Error('Invalid operation'), { code: 'invalid_request' });
  }
}

export async function startHandoffControlServer({
  store = handoffStore,
  config = {},
  socketPath = HANDOFF_CONTROL_SOCKET,
} = {}) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  await removeStaleSocket(socketPath);
  const clients = new Set();

  const server = net.createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket);
    const abortController = new AbortController();
    let body = '';
    let bytes = 0;
    let rejected = false;

    socket.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > HANDOFF_CONTROL_REQUEST_LIMIT_BYTES) {
        rejected = true;
        send(socket, { ok: false, error: 'request_too_large' });
        return;
      }
      body += chunk.toString('utf8');
    });
    socket.on('end', async () => {
      if (rejected) return;
      try {
        const request = JSON.parse(body);
        send(socket, await dispatch(request, socket, store, config, abortController));
      } catch (err) {
        send(socket, safeError(err));
      }
    });
    socket.on('close', () => {
      clients.delete(socket);
      abortController.abort();
    });
    socket.on('error', () => {
      // Errors contain no request fields and are intentionally not logged.
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      try {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      } catch (err) {
        server.close();
        try { fs.unlinkSync(socketPath); } catch { /* preserve the original chmod error */ }
        reject(err);
      }
    });
  });

  return {
    socketPath,
    close() {
      for (const socket of clients) socket.destroy();
      server.close();
      try { fs.unlinkSync(socketPath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    },
  };
}
