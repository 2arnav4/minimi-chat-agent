import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { rateLimit, applyServerTimeouts } from '../src/http/limits.js';

// Each request gets its own fake socket address, so every request is a distinct client.
function appWith(limiter: ReturnType<typeof rateLimit>) {
  const app = new Hono();
  app.use('*', limiter);
  app.get('/', (c) => c.text('ok'));
  return app;
}
const from = (app: Hono, ip: string) => app.request('/', {}, { incoming: { socket: { remoteAddress: ip } } });

test('rate limiter sweeps expired windows once per window, so memory tracks only active clients', async () => {
  let t = 1_000_000;
  const limiter = rateLimit(5, 60_000, { now: () => t });
  const app = appWith(limiter);
  for (let i = 0; i < 500; i++) assert.equal((await from(app, `10.0.${i >> 8}.${i & 255}`)).status, 200);
  assert.equal(limiter.size(), 500);
  t += 59_999; // still inside the window: nothing expires yet
  await from(app, '10.9.9.9');
  assert.equal(limiter.size(), 501);
  t += 1; // the first 500 windows are now expired; the next request triggers the sweep
  await from(app, '10.9.9.8');
  assert.equal(limiter.size(), 2, 'only the two clients seen in the current window remain');
});

test('rate limiter hard cap evicts the oldest window first, and a hot client keeps its count', async () => {
  let t = 0;
  const limiter = rateLimit(2, 60_000, { now: () => t, maxKeys: 100 });
  const app = appWith(limiter);
  await from(app, 'hot');
  await from(app, 'hot');
  assert.equal((await from(app, 'hot')).status, 429);
  for (let i = 0; i < 150; i++) {
    t += 1;
    await from(app, `c${i}`);
  }
  assert.equal(limiter.size(), 100, 'capped at maxKeys');
  // 'hot' was the oldest entry, so it was evicted: its next request starts a fresh window.
  assert.equal((await from(app, 'hot')).status, 200);
  // The newest clients are still tracked with their counts.
  await from(app, 'c149');
  assert.equal((await from(app, 'c149')).status, 429);
});

test('server timeouts close slow headers but never cut a streaming response', () => {
  const server = applyServerTimeouts({ headersTimeout: 60_000, requestTimeout: 300_000, keepAliveTimeout: 5_000, timeout: 123 });
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 30_000);
  assert.ok(server.headersTimeout <= server.requestTimeout, 'Node requires headersTimeout <= requestTimeout');
  assert.equal(server.timeout, 0, 'no idle-socket timeout, so long SSE answers survive');
});

test('server.ts applies the timeouts and the load-test server binds to loopback', () => {
  assert.match(readFileSync('src/server.ts', 'utf8'), /applyServerTimeouts\(server/);
  assert.match(readFileSync('scripts/loadtest-server.ts', 'utf8'), /hostname: '127\.0\.0\.1'/);
});

test('default Google chain starts with flash-lite and the first-chunk watchdog is 12 s', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.MODEL;
    delete process.env.OPENAI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test';
    const mod = await import(`../src/config.ts?chain=${Date.now()}`);
    assert.deepEqual(
      mod.modelChain.map((s: { modelId: string }) => s.modelId),
      ['gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-3.8-flash'],
    );
    assert.equal(mod.config.modelFirstChunkMs, 12000);
  } finally {
    process.env = saved;
  }
});

test('MODEL= still overrides the chain', async () => {
  const saved = { ...process.env };
  try {
    process.env.MODEL = 'google:gemini-3.8-flash,openai:gpt-5-mini';
    const mod = await import(`../src/config.ts?override=${Date.now()}`);
    assert.deepEqual(mod.modelChain.map((s: { provider: string; modelId: string }) => `${s.provider}:${s.modelId}`), [
      'google:gemini-3.8-flash',
      'openai:gpt-5-mini',
    ]);
  } finally {
    process.env = saved;
  }
});
