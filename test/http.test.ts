import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { createApp } from '../src/app.js';
import { resetDb } from '../src/memory/store.js';
import { config } from '../src/config.js';

/**
 * Integration tests: real HTTP routes (Hono), real SQLite file on disk, real SSE
 * streaming and the real agent loop. Only the two paid/external boundaries are
 * faked: the language model (MockLanguageModelV4) and Tavily (fetch stub).
 */

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage }) as any;
const text = (s: string) => ({
  stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }, finish('stop')]),
});
const search = (...queries: string[]) => ({
  stream: convertArrayToReadableStream([
    ...queries.map((q, i) => ({ type: 'tool-call', toolCallId: `c${i}`, toolName: 'web_search', input: JSON.stringify({ query: q }) })),
    finish('tool-calls'),
  ]),
});
const model = (...steps: any[]) => new MockLanguageModelV4({ doStream: steps as any });

let dir: string;
let fetchMock: ReturnType<typeof mock.method> | undefined;

function stubTavily(status = 200) {
  config.tavilyKey = 'test';
  fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
    if (status !== 200) return new Response('upstream down', { status });
    const q = JSON.parse(init.body).query as string;
    return new Response(JSON.stringify({ results: [{ title: `${q} official page`, url: `https://example.com/${encodeURIComponent(q)}`, content: `Facts about ${q}` }] }));
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-it-'));
  resetDb(join(dir, 'test.db'));
});
afterEach(() => {
  fetchMock?.mock.restore();
  fetchMock = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function chat(app: ReturnType<typeof createApp>, body: object) {
  const res = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = raw
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data:')))
    .filter(Boolean)
    .map((l) => JSON.parse(l!.slice(5)));
  return { res, events };
}

test('GET / and the static assets are served', async () => {
  const app = createApp({ model: model(text('x')) });
  for (const [path, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/styles.css', 'text/css'], ['/vendor/marked.js', 'javascript']]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', new RegExp(type));
  }
});

test('POST /api/chat rejects bad bodies with 400', async () => {
  const app = createApp({ model: model(text('x')) });
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 'x'.repeat(8001) }, { message: 5 }]) {
    const res = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
  }
  // No JSON content type is refused before parsing (CSRF guard); a JSON type with a broken body is a 400.
  const noType = await app.request('/api/chat', { method: 'POST', body: 'not json' });
  assert.equal(noType.status, 415);
  const notJson = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(notJson.status, 400);
});

test('full turn over HTTP: SSE events, persisted messages with sources, trace written', async () => {
  stubTavily();
  const app = createApp({ model: model(search('Neon pricing November 2026', 'Supabase pricing November 2026'), text('Neon is usage based [1]; Supabase Pro is $25 [2].')) });
  const { res, events } = await chat(app, { message: 'Compare Neon and Supabase pricing', timeZone: 'Asia/Kolkata' });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'meta');
  assert.equal(types.filter((t) => t === 'search_start').length, 2);
  assert.equal(types.filter((t) => t === 'search_end').length, 2);
  assert.equal(types.at(-1), 'done');

  const { conversationId } = events[0];
  const list = await (await app.request('/api/conversations')).json();
  assert.equal(list[0].id, conversationId);
  const msgs = await (await app.request(`/api/conversations/${conversationId}/messages`)).json();
  assert.deepEqual(msgs.map((m: any) => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].sources.length, 2);
  assert.equal(msgs[1].sources[0].n, 1);
  const traces = await (await app.request('/api/traces')).json();
  assert.equal(traces[0].metrics.searches, 2);
});

test('a follow-up in the same conversation sends earlier turns to the model', async () => {
  const m = model(text('First answer.'), text('Follow-up answer.'));
  const app = createApp({ model: m });
  const first = await chat(app, { message: 'Tell me about Postgres' });
  const conversationId = first.events[0].conversationId;
  await chat(app, { message: 'Which is cheapest?', conversationId });
  const prompt = JSON.stringify(m.doStreamCalls[1].prompt);
  assert.match(prompt, /Tell me about Postgres/);
  assert.match(prompt, /First answer\./);
});

test('imported history is recalled by date through the whole stack, and verification forces a search', async () => {
  stubTavily();
  const app = createApp({ model: model(search('HubSpot pricing November 2026'), text('HubSpot is unchanged [1].')) });
  const imp = await app.request('/api/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: 'Shortlist CRM tools for a sales team', at: '2026-11-09T10:00:00+05:30' },
        { role: 'assistant', content: 'HubSpot, Pipedrive, Zoho.', at: '2026-11-09T10:00:20+05:30' },
      ],
    }),
  });
  assert.equal(imp.status, 200);

  const m = model(search('HubSpot pricing November 2026'), text('HubSpot is unchanged [1].'));
  const app2 = createApp({ model: m });
  const { events } = await chat(app2, {
    message: 'On Monday we shortlisted CRM tools. Has any of them changed pricing since?',
    timeZone: 'Asia/Kolkata',
    now: '2026-11-11T10:30:00+05:30',
  });
  assert.deepEqual(events[0].recall.dates, ['Monday 9 November 2026']);
  const prompt = JSON.stringify(m.doStreamCalls[0].prompt);
  assert.match(prompt, /HubSpot, Pipedrive, Zoho/);
  assert.match(prompt, /Mon, 9 Nov 2026/);
  assert.deepEqual(m.doStreamCalls[0].toolChoice, { type: 'required' });
  assert.equal(events.at(-1).metrics.forcedSearch, true);
});

test('the clock override sets the stored timestamp', async () => {
  const app = createApp({ model: model(text('ok')) });
  const { events } = await chat(app, { message: 'hello', now: '2026-11-03T12:00:00+05:30' });
  const msgs = await (await app.request(`/api/conversations/${events[0].conversationId}/messages`)).json();
  assert.equal(msgs[0].createdAt, new Date('2026-11-03T12:00:00+05:30').getTime());
});

test('search provider failure degrades gracefully: error surfaced, answer still produced', async () => {
  stubTavily(503);
  const app = createApp({ model: model(search('anything'), text('I could not verify this right now.')) });
  const { events } = await chat(app, { message: 'latest news on X' });
  const end = events.find((e) => e.type === 'search_end');
  assert.match(end.error, /503/);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(!events.some((e) => e.type === 'error'));
});

test('model fallback is visible over SSE', async () => {
  const broken = new MockLanguageModelV4({ doStream: async () => { throw new Error('high demand'); } });
  const app = createApp({ model: [broken, model(text('Hi there'))] });
  const { events } = await chat(app, { message: 'hi' });
  assert.ok(events.some((e) => e.type === 'fallback'));
  assert.equal(events.at(-1).type, 'done');
});

test('all models failing returns an error event and stores no assistant message', async () => {
  const broken = () => new MockLanguageModelV4({ doStream: async () => { throw new Error('down'); } });
  const app = createApp({ model: [broken(), broken()] });
  const { events } = await chat(app, { message: 'hi' });
  assert.ok(events.some((e) => e.type === 'error'));
  const msgs = await (await app.request(`/api/conversations/${events[0].conversationId}/messages`)).json();
  assert.deepEqual(msgs.map((m: any) => m.role), ['user']);
});

test('import validation and 404s', async () => {
  const app = createApp({ model: model(text('x')) });
  const bad = await app.request('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x', at: 'not a date' }] }) });
  assert.equal(bad.status, 400);
  const empty = await app.request('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  assert.equal(empty.status, 400);
  const missing = await app.request('/api/conversations/nope/messages');
  assert.equal(missing.status, 404);
});

// ---------- request guards (DNS rebinding, CSRF, CSP) ----------

const post = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>, body = '{"message":"hi"}') =>
  app.request(`http://localhost:3000${path}`, { method: 'POST', headers, body });

test('foreign Host header is rejected while bound to loopback (DNS rebinding)', async () => {
  const app = createApp({ model: model(text('x')), host: '127.0.0.1' });
  const evil = await app.request('http://localhost/api/conversations', { headers: { host: 'evil.example:3000' } });
  assert.equal(evil.status, 403);
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
    const ok = await app.request('http://localhost/api/conversations', { headers: { host } });
    assert.equal(ok.status, 200, host);
  }
  const exposed = createApp({ model: model(text('x')), host: '0.0.0.0' });
  assert.equal((await exposed.request('http://localhost/api/conversations', { headers: { host: 'my-box.lan:3000' } })).status, 200);
});

test('API POSTs need JSON and a same-origin (or absent) Origin', async () => {
  const app = createApp({ model: model(text('x')) });
  assert.equal((await post(app, '/api/import', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(app, '/api/chat', {})).status, 415);
  assert.equal((await post(app, '/api/chat', { 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(app, '/api/chat', { 'content-type': 'application/json', origin: 'null' })).status, 403);
  assert.equal((await post(app, '/api/chat', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('the UI own request shape (same-origin JSON POST) still works', async () => {
  const app = createApp({ model: model(text('Hello')) });
  const res = await post(app, '/api/chat', { 'content-type': 'application/json', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Hello/);
});

test('pages and API responses carry CSP and nosniff', async () => {
  const app = createApp({ model: model(text('x')) });
  for (const path of ['/', '/app.js', '/api/health']) {
    const res = await app.request(path);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/, path);
    assert.match(res.headers.get('content-security-policy') ?? '', /object-src 'none'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
  }
});
