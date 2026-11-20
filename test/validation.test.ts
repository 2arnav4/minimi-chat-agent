import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { createApp } from '../src/app.js';
import { resetDb, getMessages, getDb } from '../src/memory/store.js';
import { config } from '../src/config.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const finish = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage } as any;
const say = (s: string) => ({ stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: s }, { type: 'text-end', id: 't' }, finish]) });
const textModel = (s = 'ok') => new MockLanguageModelV4({ doStream: async () => say(s) } as any);

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function events(res: Response) {
  const raw = await res.text();
  return raw
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)));
}

beforeEach(() => {
  resetDb(':memory:');
  config.allowClockOverride = true;
  config.tavilyKey = '';
});

// ---------- 1 and 5: client-supplied times must be in a sane range ----------

test('chat "now" outside 2000-01-01 .. 2099-12-31, or unparseable, is a 400', async () => {
  const app = createApp({ model: textModel() });
  for (const now of ['+275760-09-13T00:00:00.000Z', '-271821-04-20T00:00:00.000Z', '1999-12-31T23:59:59Z', '2100-01-01T00:00:00Z', 'NaN', 'not a date']) {
    const res = await post(app, '/api/chat', { message: 'hi', now });
    assert.equal(res.status, 400, now);
    assert.match((await res.json()).error, /now must be an ISO date/);
  }
  // Just inside both ends is accepted.
  assert.equal((await post(app, '/api/chat', { message: 'hi', now: '2000-01-01T00:00:00Z' })).status, 200);
  assert.equal((await post(app, '/api/chat', { message: 'hi', now: '2099-12-31T23:59:59Z' })).status, 200);
});

test('import "at" is validated like "now"; a max-date row can no longer be stored', async () => {
  const app = createApp({ model: textModel() });
  const res = await post(app, '/api/import', { messages: [{ role: 'user', content: 'zorblax pricing', at: '+275760-09-13T00:00:00.000Z' }] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at must be an ISO date/);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n, 0);
});

// ---------- 2: an unexpected crash still ends the stream with an error event ----------

test('a crash inside the turn sends an error event (code internal), not an empty stream', async () => {
  const app = createApp({ model: textModel() });
  // Make the database fail in the middle of the turn (recall reads it after the user message is stored).
  const db = getDb();
  const realPrepare = db.prepare.bind(db);
  const prep = mock.method(db, 'prepare', (sql: string) => {
    if (/messages_fts/.test(sql)) throw new Error('disk I/O error /secret/path');
    return realPrepare(sql);
  });
  const warn = mock.method(console, 'warn', () => {});
  try {
    const res = await post(app, '/api/chat', { message: 'what did we talk about regarding monitors?' });
    assert.equal(res.status, 200);
    const ev = await events(res);
    const err = ev.find((e) => e.type === 'error');
    assert.ok(err, `expected an error event, got ${JSON.stringify(ev)}`);
    assert.equal(err.code, 'internal');
    assert.doesNotMatch(JSON.stringify(ev), /secret\/path|disk I\/O/);
  } finally {
    prep.mock.restore();
    warn.mock.restore();
  }
});

// ---------- 3: conversationId ----------

test('conversationId "" means a new conversation, twice in a row, on chat and import', async () => {
  const app = createApp({ model: textModel() });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const ev = await events(await post(app, '/api/chat', { message: 'hi', conversationId: '' }));
    assert.ok(ev.some((e) => e.type === 'done'), 'turn finished');
    ids.push(ev.find((e) => e.type === 'meta').conversationId);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every((id) => id.length > 0));
  for (let i = 0; i < 2; i++) {
    const res = await post(app, '/api/import', { conversationId: '', messages: [{ role: 'user', content: 'x', at: '2026-01-01T00:00:00Z' }] });
    assert.equal(res.status, 200);
  }
});

test('conversationId must be 1-100 of [A-Za-z0-9_-]', async () => {
  const app = createApp({ model: textModel() });
  for (const bad of ['x'.repeat(101), 'a b', '../etc', 'id"or"1', 'é']) {
    assert.equal((await post(app, '/api/chat', { message: 'hi', conversationId: bad })).status, 400, bad);
    assert.equal((await post(app, '/api/import', { conversationId: bad, messages: [{ role: 'user', content: 'x', at: '2026-01-01T00:00:00Z' }] })).status, 400, bad);
  }
  assert.equal((await post(app, '/api/chat', { message: 'hi', conversationId: 'a'.repeat(100) })).status, 200);
  assert.equal((await post(app, '/api/chat', { message: 'hi', conversationId: 'abc-DEF_123' })).status, 200);
});

// ---------- 4: timeZone ----------

test('an invalid timeZone is a 400 instead of silently using the default', async () => {
  const app = createApp({ model: textModel() });
  for (const tz of ['Mars/Olympus', '../../etc/passwd', 'A'.repeat(65)]) {
    const res = await post(app, '/api/chat', { message: 'hi', timeZone: tz });
    assert.equal(res.status, 400, tz);
    assert.match((await res.json()).error, /timeZone/);
  }
  assert.equal((await post(app, '/api/chat', { message: 'hi', timeZone: 'America/New_York' })).status, 200);
  assert.equal((await post(app, '/api/chat', { message: 'hi', timeZone: null })).status, 200);
});

// ---------- 5: import title ----------

test('import title is capped at 200 characters', async () => {
  const app = createApp({ model: textModel() });
  const msg = [{ role: 'user', content: 'x', at: '2026-01-01T00:00:00Z' }];
  assert.equal((await post(app, '/api/import', { title: 'T'.repeat(201), messages: msg })).status, 400);
  assert.equal((await post(app, '/api/import', { title: 'T'.repeat(200), messages: msg })).status, 200);
});

// ---------- 6: invisible-only messages ----------

test('a message made only of zero-width characters and spaces is a 400', async () => {
  const app = createApp({ model: textModel() });
  for (const m of ['   ​ ', '‌‍', '⁠﻿\n']) {
    const res = await post(app, '/api/chat', { message: m });
    assert.equal(res.status, 400, JSON.stringify(m));
  }
  const imp = await post(app, '/api/import', { messages: [{ role: 'user', content: '​', at: '2026-01-01T00:00:00Z' }] });
  assert.equal(imp.status, 400);
  assert.equal((await post(app, '/api/chat', { message: 'hi​' })).status, 200);
});

// ---------- 7: parallel turns in one conversation ----------

test('parallel turns in one conversation are stored as question, answer, question, answer', async () => {
  let n = 0;
  // Each answer takes a different time, so without ordering the rows would interleave.
  const slow = new MockLanguageModelV4({
    doStream: async () => {
      const k = ++n;
      await new Promise((r) => setTimeout(r, k % 2 ? 30 : 5));
      return say(`answer ${k}`);
    },
  } as any);
  const app = createApp({ model: slow });
  const id = 'race-conv';
  // Seed the conversation so all requests target the same existing id.
  await events(await post(app, '/api/chat', { message: 'start', conversationId: id }));
  const N = 8;
  await Promise.all(Array.from({ length: N }, (_, i) => Promise.resolve(post(app, '/api/chat', { message: `q${i}`, conversationId: id })).then(events)));
  const roles = getMessages(id, 1000).map((m) => m.role);
  assert.equal(roles.length, 2 * (N + 1));
  for (let i = 0; i < roles.length; i++) assert.equal(roles[i], i % 2 ? 'assistant' : 'user', `row ${i}: ${roles.join(',')}`);
});
