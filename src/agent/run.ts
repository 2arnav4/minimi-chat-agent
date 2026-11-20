import { streamText, tool, stepCountIs, type ModelMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { config, buildModel, modelChain, specName } from '../config.js';
import { addMessage, createConversation, getConversation, getMessages, saveTrace, type Source } from '../memory/store.js';
import { recall } from '../memory/recall.js';
import { webSearch, formatForModel } from '../search/webSearch.js';
import { SYSTEM_PROMPT, buildTurnContent } from './prompt.js';
import { citedNumbers } from '../../public/cite.js';
import { classifyModelError, logDetail, publicMessage, type ErrorCode } from './errors.js';

/** Events streamed to the client (and recorded in the trace). */
export type AgentEvent =
  | { type: 'meta'; conversationId: string; recall: { mode: string; matched: number; dates: string[] } }
  | { type: 'search_start'; id: string; query: string }
  | { type: 'search_end'; id: string; query: string; results: number; ms: number; cached: boolean; error?: string }
  | { type: 'fallback'; from: string; to: string; reason: ErrorCode }
  | { type: 'text'; delta: string }
  | { type: 'done'; messageId: number | null; status: TurnStatus; sources: (Source & { n: number })[]; metrics: TurnMetrics }
  // message is a generic sentence safe to show; provider detail stays in the server log.
  | { type: 'error'; code: ErrorCode; message: string };

/**
 * How a turn ended. answered: full answer stored. cancelled: the client stopped it (Stop
 * button or disconnect); any partial text is stored marked as cancelled. failed: every
 * model failed; nothing is stored, so errors never become memories.
 */
export type TurnStatus = 'answered' | 'cancelled' | 'failed';

/**
 * Circuit breaker: a model that just failed is skipped for a while, so every
 * turn does not pay the cost of waiting on an overloaded model before falling back.
 */
const COOL_DOWN_MS = 3 * 60 * 1000;
const failedAt = new Map<string, number>();
const isCooling = (name: string) => Date.now() - (failedAt.get(name) ?? 0) < COOL_DOWN_MS;

/** "Is it still correct?", "has pricing changed since?", "anything new?" */
export const VERIFY_INTENT =
  /\b(still (correct|true|valid|accurate|right|the case|good)|changed|change since|since then|since (monday|tuesday|wednesday|thursday|friday|saturday|sunday|last|yesterday|\d)|any (updates?|news)|up to date|outdated|shipped|launched|released)\b/i;

export interface TurnMetrics {
  model: string;
  ttftMs: number | null; // time to first token of the answer
  totalMs: number;
  recallMs: number;
  steps: number;
  searches: number;
  searchMs: number; // slowest search in the turn (they run in parallel)
  forcedSearch: boolean;
  fallbacks: string[]; // models that failed before this answer
  inputTokens?: number;
  outputTokens?: number;
}

export interface TurnInput {
  conversationId?: string;
  text: string;
  now: Date; // injectable clock: real time in normal use, simulated in tests/evals
  timeZone: string;
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
  model?: LanguageModel | LanguageModel[]; // injectable for tests (an array is a fallback chain)
}

export async function runTurn({ conversationId, text, now, timeZone, signal, emit, model }: TurnInput): Promise<void> {
  const t0 = performance.now();
  const conv = (conversationId && getConversation(conversationId)) || createConversation(text.slice(0, 60), now.getTime(), conversationId);

  // 1. Short-term memory: the recent turns of this conversation, verbatim.
  const recent = getMessages(conv.id, config.recentTurns * 2);
  const userMsg = addMessage(conv.id, 'user', text, now.getTime());

  // 2. Long-term memory: resolve dates + topic, pull matching past exchanges. Pure SQLite, a few ms.
  const tr = performance.now();
  const mem = recall(text, now, timeZone, [...recent.map((m) => m.id), userMsg.id]);
  const recallMs = Math.round(performance.now() - tr);
  emit({ type: 'meta', conversationId: conv.id, recall: { mode: mem.mode, matched: mem.matched, dates: mem.ranges.map((r) => r.label) } });

  const messages: ModelMessage[] = [
    // A stopped answer is labelled so the model does not build on it as if it were complete.
    ...recent.map(
      (m) =>
        ({
          role: m.role,
          content: m.status === 'cancelled' ? `${m.content}\n\n[This answer was stopped by the user before it finished.]` : m.content,
        }) as ModelMessage,
    ),
    { role: 'user', content: buildTurnContent(text, now, timeZone, mem.block) },
  ];

  // A question that asks whether something from the past still holds must be checked
  // live. Models sometimes "confirm" an old answer from memory alone, so the harness
  // forces at least one search on the first step instead of trusting the model to.
  const mustVerify = mem.mode !== 'none' && mem.matched > 0 && VERIFY_INTENT.test(text);

  // 3. Agent loop with the single tool.
  const sources: (Source & { n: number })[] = [];
  let searches = 0;
  let searchMs = 0;
  const webSearchTool = tool({
    description:
      'Search the web for current information. Returns up to 5 results with cleaned page text. ' +
      'Call it several times in parallel for several independent items.',
    inputSchema: z.object({
      query: z.string().describe('A specific search query. Include month and year for time-sensitive topics.'),
      recency: z.enum(['day', 'week', 'month', 'year']).optional().describe('Only return results from this recent period.'),
      topic: z.enum(['general', 'news']).optional().describe('Use "news" for announcements, launches and recent events.'),
    }),
    execute: async (args, { toolCallId }) => {
      searches++;
      const out = await webSearch(args);
      searchMs = Math.max(searchMs, out.ms);
      emit({ type: 'search_end', id: toolCallId, query: args.query, results: out.results.length, ms: out.ms, cached: out.cached, error: out.error });
      const offset = sources.length;
      out.results.forEach((r, i) => sources.push({ n: offset + i + 1, title: r.title, url: r.url, ...(r.published ? { published: r.published } : {}) }));
      return formatForModel(out, offset);
    },
  });

  let answer = '';
  let ttftMs: number | null = null;
  let steps = 0;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  // Set when the model's own finish part arrives: an abort after that point (client closing
  // the tab right at the end) must not mark a complete answer as cancelled.
  let finished = false;
  let failed = false; // set when the turn ends on a model error, even after partial text

  // Fallback chain: if a model fails (overloaded, quota, outage) before any answer text
  // reached the user, the same turn is retried on the next model. Searches already run
  // are served from the cache, so a retry costs little. Once text has streamed we stop,
  // because switching models mid-sentence would show the user two half answers.
  const chain = model
    ? (Array.isArray(model) ? model : [model]).map((m, i) => ({ name: `injected-${i}`, model: m }))
    : modelChain.map((m) => ({ name: specName(m), model: buildModel(m) }));
  let usedModel = chain[0]?.name ?? 'none';
  const fallbacks: string[] = [];

  // Skip models on cool-down, but always keep at least the last one.
  const healthy = chain.filter((c, i) => !isCooling(c.name) || i === chain.length - 1);
  const live = healthy.length ? healthy : chain;
  chain.length = 0;
  chain.push(...live);

  for (let i = 0; i < chain.length; i++) {
    usedModel = chain[i].name;
    sources.length = 0;
    // Watchdog: the SDK's own first-chunk timeout does not fire when the provider never
    // sends response headers (seen with an overloaded Gemini model), so each attempt gets
    // its own abort controller that trips if no stream part arrives in time.
    const attempt = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    const arm = (ms: number) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => attempt.abort(new Error(`no response from model for ${ms / 1000}s`)), ms);
    };
    arm(config.modelFirstChunkMs);
    const attemptSignal = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal;
    try {
      const result = streamText({
        model: chain[i].model,
        instructions: { role: 'system', content: SYSTEM_PROMPT },
        messages,
        tools: { web_search: webSearchTool },
        stopWhen: stepCountIs(config.maxSteps),
        // Last allowed step: force a written answer. First step of a "still correct?" question: force a search.
        prepareStep: ({ stepNumber }) =>
          stepNumber >= config.maxSteps - 1
            ? { toolChoice: 'none' as const }
            : stepNumber === 0 && mustVerify
              ? { toolChoice: 'required' as const }
              : {},
        providerOptions: { google: { thinkingConfig: { thinkingLevel: config.geminiThinking } } },
        // No retries while a fallback exists: switching models beats waiting on an overloaded one.
        maxRetries: i < chain.length - 1 ? 0 : 2,
        abortSignal: attemptSignal,
        // Errors are handled below (fallback or error event); log one line, not a stack trace.
        onError: ({ error }) => console.warn(`[${chain[i].name}] ${logDetail(error, 200)}`),
      });

      for await (const part of result.fullStream) {
        // Any progress (including tool calls and step boundaries) re-arms the watchdog.
        // Long waits inside our own search tool are bounded by the search timeout instead.
        arm(config.modelChunkMs);
        if (part.type === 'text-delta') {
          if (ttftMs === null) ttftMs = Math.round(performance.now() - t0);
          answer += part.text;
          emit({ type: 'text', delta: part.text });
        } else if (part.type === 'tool-call') {
          const q = (part.input as { query?: string })?.query ?? '';
          emit({ type: 'search_start', id: part.toolCallId, query: q });
        } else if (part.type === 'finish-step') {
          steps++;
        } else if (part.type === 'finish') {
          finished = true;
          usage = { inputTokens: part.totalUsage?.inputTokens, outputTokens: part.totalUsage?.outputTokens };
        } else if (part.type === 'error') {
          throw part.error;
        } else if (part.type === 'abort' && !signal?.aborted) {
          throw attempt.signal.reason instanceof Error ? attempt.signal.reason : new Error('model call aborted');
        }
      }
      // An empty answer is a failure too (e.g. the model stopped after searching).
      if (!answer.trim()) throw new Error('model returned an empty answer');
      failedAt.delete(chain[i].name);
      clearTimeout(watchdog);
      break;
    } catch (err) {
      clearTimeout(watchdog);
      // The user stopped the turn: not a model failure, so no error event and no circuit-breaker hit.
      if (signal?.aborted) break;
      const code = classifyModelError(err);
      const canFallBack = !answer && i < chain.length - 1 && !signal?.aborted;
      if (!signal?.aborted) failedAt.set(chain[i].name, Date.now());
      if (canFallBack) {
        fallbacks.push(`${chain[i].name}: ${code}`);
        emit({ type: 'fallback', from: chain[i].name, to: chain[i + 1].name, reason: code });
        continue;
      }
      console.warn(`[${chain[i].name}] turn failed (${code}): ${logDetail(err)}`);
      failed = true;
      emit({ type: 'error', code, message: publicMessage(code) });
      break;
    }
  }

  // 4. Persist the answer with the sources it actually cited, so a later
  //    "is that still correct?" can see exactly what was claimed and from where.
  // Accepts [3] and grouped forms like [3, 7].
  // Same rule as the UI: "[n]" inside code or a link target is not a citation.
  const cited = citedNumbers(answer);
  const usedSources = sources.filter((s) => cited.has(s.n));
  const totalMs = Math.round(performance.now() - t0);
  // A failed turn with no answer is not stored as an assistant message, so errors never become "memories".
  // A stopped turn keeps its partial text, marked cancelled, so history shows what was said without
  // presenting it as a finished answer.
  const cancelled = (signal?.aborted ?? false) && !finished;
  // A model error mid-answer is a failed turn too: the partial text is not stored as if it were complete.
  const status: TurnStatus = cancelled ? 'cancelled' : answer.trim() && !failed ? 'answered' : 'failed';
  // Nothing is stored for a failed turn, or for a stop that came before any text arrived.
  const saved = status !== 'failed' && answer.trim()
    ? addMessage(conv.id, 'assistant', answer, now.getTime() + Math.max(totalMs, 1), usedSources, cancelled ? 'cancelled' : 'answered')
    : null;

  const metrics: TurnMetrics = {
    model: usedModel,
    fallbacks,
    ttftMs,
    totalMs,
    recallMs,
    steps,
    searches,
    searchMs,
    forcedSearch: mustVerify,
    ...usage,
  };
  saveTrace(conv.id, now.getTime(), { question: text, status, recall: { mode: mem.mode, matched: mem.matched, dates: mem.ranges.map((r) => r.label) }, metrics });
  emit({ type: 'done', messageId: saved?.id ?? null, status, sources: usedSources, metrics });
}
