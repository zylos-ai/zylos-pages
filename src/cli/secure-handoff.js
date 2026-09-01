#!/usr/bin/env node

import net from 'node:net';
import { HANDOFF_CONTROL_REQUEST_LIMIT_BYTES, HANDOFF_CONTROL_SOCKET } from '../handoff/handoff-control.js';

async function readRequest() {
  let body = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > HANDOFF_CONTROL_REQUEST_LIMIT_BYTES) throw new Error('request_too_large');
    body += chunk.toString('utf8');
  }
  JSON.parse(body);
  return body;
}

async function exchange(body) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(HANDOFF_CONTROL_SOCKET);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(body));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

try {
  const response = await exchange(await readRequest());
  const parsed = JSON.parse(response);
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
  if (!parsed.ok) process.exitCode = 1;
} catch (err) {
  const code = ['ENOENT', 'ECONNREFUSED'].includes(err.code) ? 'service_unavailable' : 'invalid_request';
  process.stderr.write(`${JSON.stringify({ ok: false, error: code })}\n`);
  process.exitCode = 1;
}
