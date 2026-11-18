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
