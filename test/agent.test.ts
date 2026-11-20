import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { resetDb, getMessages } from '../src/memory/store.js';
import { runTurn, type AgentEvent } from '../src/agent/run.js';
import { config } from '../src/config.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage }) as any;

beforeEach(() => resetDb(':memory:'));

test('agent runs parallel searches, streams the answer, stores cited sources', async () => {
  config.tavilyKey = 'test';
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
    const q = JSON.parse(init.body).query as string;
    return new Response(JSON.stringify({ results: [{ title: `${q} page`, url: `https://example.com/${encodeURIComponent(q)}`, content: `About ${q}` }] }));
  });

  const model = new MockLanguageModelV4({
    doStream: [
      {
        stream: convertArrayToReadableStream([
          { type: 'tool-call', toolCallId: 'a', toolName: 'web_search', input: JSON.stringify({ query: 'HubSpot pricing November 2026' }) },
          { type: 'tool-call', toolCallId: 'b', toolName: 'web_search', input: JSON.stringify({ query: 'Pipedrive pricing November 2026' }) },
          finish('tool-calls'),
        ]),
      },
      {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'HubSpot is unchanged [1]; ' },
          { type: 'text-delta', id: 't', delta: 'Pipedrive raised prices [2].' },
          { type: 'text-end', id: 't' },
          finish('stop'),
        ]),
      },
    ] as any,
  });

  const events: AgentEvent[] = [];
  await runTurn({ text: 'Did HubSpot or Pipedrive change pricing?', now: new Date('2026-11-11T05:00:00Z'), timeZone: 'Asia/Kolkata', emit: (e) => events.push(e), model });

  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === 'search_start').length, 2);
  assert.equal(types.filter((t) => t === 'search_end').length, 2);
  assert.equal(fetchMock.mock.callCount(), 2);

  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(done.sources.length, 2);
  assert.equal(done.metrics.searches, 2);
  assert.ok(done.metrics.ttftMs !== null);

  const meta = events[0] as Extract<AgentEvent, { type: 'meta' }>;
  const stored = getMessages(meta.conversationId);
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant']);
  assert.equal(stored[1].content, 'HubSpot is unchanged [1]; Pipedrive raised prices [2].');
  assert.equal(stored[1].sources.length, 2);

  // The model saw the current time in the user's timezone.
  const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
  assert.match(prompt, /Current time: Wed, 11 Nov 2026/);
  fetchMock.mock.restore();
});

test('repeat searches are served from cache', async () => {
  config.tavilyKey = 'test';
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [] })));
  const { webSearch } = await import('../src/search/webSearch.js');
  await webSearch({ query: 'Neon pricing' });
  const second = await webSearch({ query: '  neon PRICING ' });
  assert.equal(second.cached, true);
  assert.equal(fetchMock.mock.callCount(), 1);
  fetchMock.mock.restore();
});

test('falls back to the next model when the first one fails before answering', async () => {
  const broken = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('This model is currently experiencing high demand.');
    },
  });
  const working = new MockLanguageModelV4({
    doStream: [
      {
        stream: convertArrayToReadableStream([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'Hello!' },
          { type: 'text-end', id: 't' },
          finish('stop'),
        ]),
      },
    ] as any,
  });
  const events: AgentEvent[] = [];
  await runTurn({ text: 'hi', now: new Date(), timeZone: 'Asia/Kolkata', emit: (e) => events.push(e), model: [broken, working] });
  assert.ok(events.some((e) => e.type === 'fallback'));
  assert.ok(!events.some((e) => e.type === 'error'));
  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(done.metrics.model, 'injected-1');
  assert.equal(done.metrics.fallbacks.length, 1);
});

test('falls back when a model hangs without sending anything', async () => {
  const { config } = await import('../src/config.js');
  const saved = config.modelFirstChunkMs;
  config.modelFirstChunkMs = 200;
  const hanging = new MockLanguageModelV4({
    doStream: async ({ abortSignal }: any) => ({
      stream: new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      }),
    }),
  } as any);
  const working = new MockLanguageModelV4({
    doStream: [{ stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Hi' }, { type: 'text-end', id: 't' }, finish('stop')]) }] as any,
  });
  const events: AgentEvent[] = [];
  await runTurn({ text: 'hi', now: new Date(), timeZone: 'Asia/Kolkata', emit: (e) => events.push(e), model: [hanging, working] });
  config.modelFirstChunkMs = saved;
  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(done.metrics.model, 'injected-1');
});

test('redactSecrets, classifyModelError and sanitizeTrace', async () => {
  const { redactSecrets, classifyModelError, sanitizeTrace } = await import('../src/agent/errors.js');
  const raw = 'url ?key=abc123&x=1 AIzaSyA1234567890abcdefghijklmnop sk-proj-abcdefghijklmnop1234 tvly-dev-12345678 Authorization: Bearer abc.def.ghi123';
  const red = redactSecrets(raw);
  for (const leak of ['abc123', 'AIza', 'sk-proj', 'tvly-', 'abc.def']) assert.ok(!red.includes(leak), `${leak} leaked: ${red}`);
  assert.match(red, /key=\[redacted\]/);
  assert.equal(classifyModelError(Object.assign(new Error('x'), { statusCode: 429 })), 'quota');
  assert.equal(classifyModelError(new Error('RESOURCE_EXHAUSTED')), 'quota');
  assert.equal(classifyModelError(Object.assign(new Error('x'), { statusCode: 503 })), 'model_unavailable');
  assert.equal(classifyModelError(new Error('This model is currently experiencing high demand')), 'model_unavailable');
  assert.equal(classifyModelError(new Error('API key not valid')), 'auth');
  assert.equal(classifyModelError(new Error('no response from model for 20s')), 'timeout');
  assert.equal(classifyModelError(new Error('model returned an empty answer')), 'empty_answer');
  assert.equal(classifyModelError(new Error('weird')), 'internal');
  const old = { metrics: { fallbacks: ['google:a: 429 quota ?key=AIzaSyA1234567890abcdefghijklmnop', 'google:b: quota'] } };
  assert.deepEqual(sanitizeTrace(old).metrics.fallbacks, ['google:a: quota', 'google:b: quota']);
});

test('a stopped turn stores its partial text as cancelled, with no error event', async () => {
  const { getMessages } = await import('../src/memory/store.js');
  const ctl = new AbortController();
  // Streams one word, then waits; the caller stops the turn after the first word arrives.
  const slow = new MockLanguageModelV4({
    doStream: async ({ abortSignal }: any) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial ' });
          abortSignal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }),
    }),
  } as any);
  const events: AgentEvent[] = [];
  await runTurn({
    text: 'tell me a long story',
    now: new Date(),
    timeZone: 'Asia/Kolkata',
    signal: ctl.signal,
    emit: (e) => {
      events.push(e);
      if (e.type === 'text') ctl.abort();
    },
    model: slow,
  });
  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(done.status, 'cancelled');
  assert.ok(!events.some((e) => e.type === 'error'), 'a user stop is not an error');
  const meta = events.find((e) => e.type === 'meta') as Extract<AgentEvent, { type: 'meta' }>;
  const stored = getMessages(meta.conversationId);
  assert.equal(stored.length, 2);
  assert.equal(stored[1].status, 'cancelled');
  assert.equal(stored[1].content, 'Partial ');
});

test('a completed turn is stored as answered', async () => {
  const model = new MockLanguageModelV4({
    doStream: [{ stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }, finish('stop')]) }] as any,
  });
  const events: AgentEvent[] = [];
  await runTurn({ text: 'hi', now: new Date(), timeZone: 'Asia/Kolkata', emit: (e) => events.push(e), model });
  const done = events.find((e) => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>;
  assert.equal(done.status, 'answered');
});

test('a model error after partial text is a failed turn: error shown, partial answer not stored', async () => {
  const broken = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Supabase Pro costs ' });
          controller.error(new Error('503 service unavailable'));
        },
      }),
    }),
  } as any);
  const warn = mock.method(console, 'warn', () => {});
  const events: AgentEvent[] = [];
  await runTurn({ text: 'postgres hosting prices', now: new Date(), timeZone: 'Asia/Kolkata', emit: (e) => events.push(e), model: broken });
  warn.mock.restore();
  assert.ok(events.some((e) => e.type === 'error'), 'the user sees an error');
  const meta = events.find((e) => e.type === 'meta') as Extract<AgentEvent, { type: 'meta' }>;
  const stored = getMessages(meta.conversationId);
  assert.deepEqual(stored.map((m) => m.role), ['user']);
});

test('a stop before any text arrives stores no empty assistant message', async () => {
  const ctl = new AbortController();
  const silent = new MockLanguageModelV4({
    doStream: async ({ abortSignal }: any) => ({
      stream: new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          setTimeout(() => ctl.abort(), 0);
        },
      }),
    }),
  } as any);
  const events: AgentEvent[] = [];
  await runTurn({ text: 'long question', now: new Date(), timeZone: 'Asia/Kolkata', signal: ctl.signal, emit: (e) => events.push(e), model: silent });
  const meta = events.find((e) => e.type === 'meta') as Extract<AgentEvent, { type: 'meta' }>;
  assert.deepEqual(getMessages(meta.conversationId).map((m) => m.role), ['user']);
});

test('recent history sent to the model has old [n] citations stripped', async () => {
  const { createConversation, addMessage } = await import('../src/memory/store.js');
  const conv = createConversation('history', Date.now() - 60_000);
  addMessage(conv.id, 'user', 'Supabase price?', Date.now() - 60_000);
  addMessage(conv.id, 'assistant', 'Supabase Pro is $25 [3][5].', Date.now() - 59_000);
  let seen = '';
  const spy = new MockLanguageModelV4({
    doStream: async ({ prompt }: any) => {
      seen = JSON.stringify(prompt);
      return { stream: convertArrayToReadableStream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, finish('stop')] as any) };
    },
  } as any);
  await runTurn({ text: 'and Neon?', conversationId: conv.id, now: new Date(), timeZone: 'Asia/Kolkata', emit: () => {}, model: spy });
  assert.match(seen, /"text":"Supabase Pro is \$25\."/, 'assistant history has its [n] markers removed');
});

test('fresh-data questions force a search; maths, greetings and memory-only questions do not', async () => {
  const { FRESH_INTENT } = await import('../src/agent/run.js');
  for (const q of ['Given all that, which managed Postgres option is cheapest for us right now?', 'What is the latest Node.js LTS?', 'How much is Supabase Pro?', 'current pricing of Neon', 'price of a MacBook Air M3 in India']) {
    assert.ok(FRESH_INTENT.test(q), q);
  }
  for (const q of ['What is 12% of 950?', 'Hi! What can you do?', 'What did I ask you yesterday?', 'Write me a haiku about databases']) {
    assert.ok(!FRESH_INTENT.test(q), q);
  }
});
