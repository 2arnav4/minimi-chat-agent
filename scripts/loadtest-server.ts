import { serve } from '@hono/node-server';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { resetDb } from '../src/memory/store.js';

/**
 * Load-test server: the real app (routes, SQLite, recall, agent loop, SSE) with the
 * two paid boundaries replaced by fakes that only add latency. Never calls Gemini or Tavily.
 * Usage: DB_PATH=/tmp/load.db tsx scripts/loadtest-server.ts
 */
const MODEL_MS = Number(process.env.FAKE_MODEL_MS ?? 400);
const SEARCH_MS = Number(process.env.FAKE_SEARCH_MS ?? 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage });

// First step searches (unique query, so the cache is not doing all the work); second step answers.
const model = new MockLanguageModelV4({
  doStream: async ({ prompt }: any) => {
    await sleep(MODEL_MS / 2);
    const hasToolResult = prompt.some((m: any) => m.role === 'tool');
    const parts = hasToolResult
      ? [{ type: 'text-start', id: 't' }, ...'Here is the answer with a source [1].'.split(' ').map((w) => ({ type: 'text-delta', id: 't', delta: w + ' ' })), { type: 'text-end', id: 't' }, finish('stop')]
      : [{ type: 'tool-call', toolCallId: 'c' + Math.random(), toolName: 'web_search', input: JSON.stringify({ query: 'q ' + Math.random() }) }, finish('tool-calls')];
    return { stream: convertArrayToReadableStream(parts as any) };
  },
} as any);

config.tavilyKey = 'fake';
// Every load-test request comes from one local client; the per-client rate limit would turn the test into a 429 test.
config.limits.chatPerMinute = 0;
config.limits.importPerMinute = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes('api.tavily.com')) {
    await sleep(SEARCH_MS);
    return new Response(JSON.stringify({ results: [{ title: 'Fake', url: 'https://example.com', content: 'fake content' }] }));
  }
  return realFetch(url, init);
}) as typeof fetch;

resetDb(process.env.DB_PATH || '/tmp/load.db');
serve({ fetch: createApp({ model }).fetch, port: Number(process.env.PORT || 3456) }, (i) => console.log(`load-test server on ${i.port}`));
