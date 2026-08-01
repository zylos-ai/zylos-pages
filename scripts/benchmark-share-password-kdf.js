import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { hashSharePassword, DEFAULT_SHARE_PASSWORD_SCRYPT } from '../src/security/share-password-kdf.js';
import { SharePasswordRateLimiter } from '../src/security/share-password-rate-limit.js';

const samples = Number.parseInt(process.env.PAGES_KDF_BENCHMARK_SAMPLES || '12', 10);
const concurrency = Number.parseInt(process.env.PAGES_KDF_BENCHMARK_CONCURRENCY || '4', 10);
if (!Number.isSafeInteger(samples) || samples < 4 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > samples) {
  throw new Error('Benchmark samples/concurrency are invalid');
}

const limiter = new SharePasswordRateLimiter({ tokenMax: samples, ipMax: samples });
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
const durations = [];
let cursor = 0;
eventLoop.enable();
const started = performance.now();

async function worker(workerId) {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= samples) return;
    const budget = limiter.consume({ tokenId: 'a'.repeat(32), clientIp: `192.0.2.${workerId + 1}` });
    if (!budget.allowed) throw new Error('Benchmark limiter unexpectedly rejected an admitted sample');
    const operationStart = performance.now();
    await hashSharePassword(`benchmark-secret-${index}`);
    durations.push(performance.now() - operationStart);
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
const totalMs = performance.now() - started;
eventLoop.disable();

// Discriminating negative control: the exhausted budget is evaluated before
// the expensive callback. Reversing that order makes kdfCalls become 2.
const negativeLimiter = new SharePasswordRateLimiter({ tokenMax: 1, ipMax: 2 });
let kdfCalls = 0;
async function guardedKdf() {
  const budget = negativeLimiter.consume({ tokenId: 'b'.repeat(32), clientIp: '198.51.100.1' });
  if (!budget.allowed) return false;
  kdfCalls += 1;
  await hashSharePassword('negative-control-secret');
  return true;
}
await guardedKdf();
await guardedKdf();
if (kdfCalls !== 1) throw new Error('Pre-KDF limiter negative control failed');

durations.sort((a, b) => a - b);
const percentile = value => durations[Math.min(durations.length - 1, Math.ceil(durations.length * value) - 1)];
process.stdout.write(`${JSON.stringify({
  parameters: DEFAULT_SHARE_PASSWORD_SCRYPT,
  samples,
  concurrency,
  totalMs: Number(totalMs.toFixed(2)),
  operationMs: {
    p50: Number(percentile(0.50).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
    max: Number(durations.at(-1).toFixed(2)),
  },
  eventLoopDelayMs: {
    p95: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
    max: Number((eventLoop.max / 1e6).toFixed(2)),
  },
  preKdfLimiterNegativeControl: { passed: true, kdfCalls },
}, null, 2)}\n`);
