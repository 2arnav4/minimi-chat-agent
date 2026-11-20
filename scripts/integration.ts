import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Integration run over real HTTP against a running server: real Hono routes,
 * guards, limits, SQLite file, recall, agent loop and SSE. Run it against the
 * load-test server, which fakes only the model and Tavily, so it costs nothing:
 *
 *   ALLOW_CLOCK_OVERRIDE=true DB_PATH=/tmp/it.db PORT=3304 npx tsx scripts/loadtest-server.ts &
 *   BASE=http://localhost:3304 npx tsx --test scripts/integration.ts
 *
 * Every run makes its own conversations (random ids and a random topic word),
 * so it never depends on data an earlier run left behind.
 */

const BASE = process.env.BASE || 'http://localhost:3304';
const RUN = randomUUID().slice(0, 8);
const TOPIC = `zq${RUN.replace(/[^a-z]/g, '')}x`; // a word no other run has used
const json = { 'content-type': 'application/json' };

type Ev = { type: string; [k: string]: any };

async function chat(body: object): Promise<{ status: number; events: Ev[]; headers: Headers }> {
  const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = raw
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5)));
  return { status: res.status, events, headers: res.headers };
}

const post = (path: string, body: string, headers: Record<string, string> = json) => fetch(`${BASE}${path}`, { method: 'POST', headers, body });

test(`[run ${RUN}] health is up and reports the clock flag`, async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert.equal(typeof h.ok, 'boolean');
  assert.equal(h.clockOverride, true, 'start the server with ALLOW_CLOCK_OVERRIDE=true for this run');
});

test(`[run ${RUN}] chat streams meta -> search -> text -> done over SSE, and persists both messages`, async () => {
  const conversationId = `it-${RUN}-chat`;
  const { status, events, headers } = await chat({ conversationId, message: `What is the price of ${TOPIC}?`, timeZone: 'Asia/Kolkata' });
  assert.equal(status, 200);
  assert.match(headers.get('content-type') ?? '', /text\/event-stream/);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'meta');
  assert.ok(types.includes('search_start') && types.includes('search_end'), types.join(','));
  assert.ok(types.includes('text'));
  assert.equal(types.at(-1), 'done');
  const done = events.at(-1)!;
  assert.equal(done.status, 'answered');
  assert.ok(done.messageId > 0);
  assert.equal(done.sources.length, 1, 'the fake answer cites [1]');
  assert.ok(done.metrics.searches >= 1);

  const msgs = await (await fetch(`${BASE}/api/conversations/${conversationId}/messages`)).json();
  assert.deepEqual(msgs.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].status, 'answered');
  assert.equal(msgs[1].sources[0].n, 1);

  const list = await (await fetch(`${BASE}/api/conversations`)).json();
  assert.ok(list.some((c: any) => c.id === conversationId), 'conversation appears in the list');
});

test(`[run ${RUN}] a second turn continues the same conversation`, async () => {
  const conversationId = `it-${RUN}-multi`;
  await chat({ conversationId, message: 'first question' });
  await chat({ conversationId, message: 'second question' });
  const msgs = await (await fetch(`${BASE}/api/conversations/${conversationId}/messages`)).json();
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.filter((m: any) => m.role === 'user').map((m: any) => m.content), ['first question', 'second question']);
});

test(`[run ${RUN}] import with timestamps, then a dated question recalls it`, async () => {
  const imp = await post(
    '/api/import',
    JSON.stringify({
      title: `import ${RUN}`,
      messages: [
        { role: 'user', content: `Which ${TOPIC} hosting is cheapest?`, at: '2026-11-03T05:30:00Z' },
        { role: 'assistant', content: `${TOPIC} Pro is 25 dollars a month.`, at: '2026-11-03T05:30:09Z' },
      ],
    }),
  );
  assert.equal(imp.status, 200);
  const { conversationId, imported } = await imp.json();
  assert.equal(imported, 2);
  const stored = await (await fetch(`${BASE}/api/conversations/${conversationId}/messages`)).json();
  assert.equal(stored[0].createdAt, Date.parse('2026-11-03T05:30:00Z'), 'original timestamp kept');

  const { events } = await chat({ message: `What did I ask you on 3 November about ${TOPIC}?`, timeZone: 'Asia/Kolkata', now: '2026-11-20T06:00:00Z' });
  const meta = events.find((e) => e.type === 'meta')!;
  assert.equal(meta.recall.mode, 'date');
  assert.ok(meta.recall.matched >= 1, `recall matched ${meta.recall.matched}`);
  assert.ok(meta.recall.dates.some((d: string) => /3 November 2026/.test(d)), meta.recall.dates.join(' | '));

  const topic = await chat({ message: `What did we talk about regarding ${TOPIC}?`, timeZone: 'Asia/Kolkata' });
  const tm = topic.events.find((e) => e.type === 'meta')!;
  assert.equal(tm.recall.mode, 'topic');
  assert.ok(tm.recall.matched >= 1);
});

test(`[run ${RUN}] guards: rebinding Host 403, wrong content type 415, cross-origin 403`, async () => {
  // fetch() will not let us set Host, so use a raw HTTP request.
  const { request } = await import('node:http');
  const url = new URL(BASE);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await post('/api/chat', JSON.stringify({ message: 'hi' }), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/chat', JSON.stringify({ message: 'hi' }), { ...json, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/import', '{}', { ...json, 'sec-fetch-site': 'cross-site' })).status, 403);
  const page = await fetch(`${BASE}/`);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test(`[run ${RUN}] limits and validation: 413 for big bodies, 400 for bad input, 404 for unknown conversation`, async () => {
  assert.equal((await post('/api/chat', JSON.stringify({ message: 'a'.repeat(70_000) }))).status, 413);
  assert.equal((await post('/api/import', JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(2_200_000), at: '2026-11-03T10:00:00Z' }] }))).status, 413);
  assert.equal((await post('/api/chat', JSON.stringify({ message: 'a'.repeat(8001) }))).status, 400);
  assert.equal((await post('/api/chat', JSON.stringify({ message: '' }))).status, 400);
  assert.equal((await post('/api/chat', '{not json')).status, 400);
  assert.equal((await post('/api/chat', JSON.stringify({ message: ['array'] }))).status, 400);
  assert.equal((await post('/api/import', JSON.stringify({ messages: [{ role: 'system', content: 'x', at: '2026-11-03T10:00:00Z' }] }))).status, 400);
  assert.equal((await post('/api/import', JSON.stringify({ messages: [{ role: 'user', content: 'x', at: 'not a date' }] }))).status, 400);
  const tooMany = Array.from({ length: 501 }, () => ({ role: 'user', content: 'x', at: '2026-11-03T10:00:00Z' }));
  assert.equal((await post('/api/import', JSON.stringify({ messages: tooMany }))).status, 400);
  const missing = await fetch(`${BASE}/api/conversations/does-not-exist-${RUN}/messages`);
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, 'string', 'errors are JSON');
});

test(`[run ${RUN}] traces record each turn with status and metrics, without provider detail`, async () => {
  const marker = `trace-marker-${RUN}`;
  await chat({ conversationId: `it-${RUN}-trace`, message: marker });
  const traces = await (await fetch(`${BASE}/api/traces`)).json();
  const t = traces.find((x: any) => x.question === marker);
  assert.ok(t, 'trace for this turn is listed');
  assert.equal(t.status, 'answered');
  assert.equal(typeof t.metrics.totalMs, 'number');
  assert.doesNotMatch(JSON.stringify(traces), /AIza|tvly-[A-Za-z0-9]{8}|sk-[A-Za-z0-9]{16}/);
});
