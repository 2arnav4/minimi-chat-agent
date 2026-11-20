import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { config, missingKeys, modelChain, specName } from './config.js';
import type { LanguageModel } from 'ai';
import { runTurn } from './agent/run.js';
import { logDetail, publicMessage, sanitizeTrace } from './agent/errors.js';
import { csrfGuard, hostGuard, securityHeaders } from './http/guards.js';
import { rateLimit, sizeLimit } from './http/limits.js';
import { addMessage, createConversation, getConversation, getDb, getMessages, listConversations, recentTraces } from './memory/store.js';

const require = createRequire(import.meta.url);

export interface AppDeps {
  /** Inject a model (or fallback chain) instead of building one from .env. Used by tests and the load test. */
  model?: LanguageModel | LanguageModel[];
  /** The address the server binds to. Loopback (the default) turns on the Host check. */
  host?: string;
}

/** Where the server listens. Loopback by default: the app has no login, so it must not be reachable from the network. */
export const bindHost = () => process.env.HOST || '127.0.0.1';

const isValidTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The clock is injectable: a request may say what "now" is (dev clock), only when ALLOW_CLOCK_OVERRIDE=true. */
function resolveNow(override?: string): Date {
  return override && config.allowClockOverride ? new Date(override) : new Date();
}

// ---------- request field rules (shared by chat and import) ----------

/**
 * Accepted range for a client-supplied time ("now" on chat, "at" on import). Dates far
 * outside it are not just odd: a stored timestamp past JavaScript's maximum date made
 * every later recall of that topic throw, and the minimum date crashed the turn.
 */
// Fixed bounds rather than "now + 1 year": the Dev clock may legitimately pretend a future date,
// and the check must not depend on the server clock (tests mock it).
const EARLIEST_MS = Date.UTC(2000, 0, 1);
const LATEST_MS = Date.UTC(2100, 0, 1);
const inTimeRange = (s: string) => {
  const t = new Date(s).getTime();
  return Number.isFinite(t) && t >= EARLIEST_MS && t < LATEST_MS;
};
const timeField = (name: string) => z.string().max(64).refine(inTimeRange, `${name} must be an ISO date between 2000-01-01 and 2099-12-31`);

/** "" and null both mean "no conversation yet"; anything else must be a plain id (it becomes a primary key). */
const conversationIdField = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/, 'conversationId must be 1-100 letters, digits, "-" or "_"')
    .optional(),
);

const timeZoneField = z
  .string()
  .max(64, 'timeZone is too long')
  .refine(isValidTz, 'timeZone must be a valid IANA time zone, e.g. Asia/Kolkata')
  .nullish()
  .transform((v) => v ?? undefined);

// Zero-width and other invisible characters do not count as content: a message made only of them is empty.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
const hasVisibleText = (s: string) => s.replace(INVISIBLE, '').trim().length > 0;

/**
 * Turns in one conversation run one at a time, in arrival order. Without this, two tabs
 * (or a double submit) interleave: both questions are stored first, then both answers,
 * and the question/answer pairing that recall relies on matches the wrong messages.
 * Trade-off: the lock is in-process, so it does not cover several server instances, and
 * a second message in the same conversation waits for the first answer to finish.
 */
const turnTails = new Map<string, Promise<void>>();
async function inConversationOrder(id: string | undefined, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  if (!id) return run(); // a brand-new conversation cannot collide with anything
  const prev = turnTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  turnTails.set(id, tail);
  try {
    await prev;
    if (!signal.aborted) await run(); // a request cancelled while waiting never starts its turn
  } finally {
    release();
    if (turnTails.get(id) === tail) turnTails.delete(id); // idle conversations leave no entry behind
  }
}

/** Builds the HTTP app without starting a server, so tests can call routes directly. */
export function createApp(deps: AppDeps = {}) {
  getDb();
  const app = new Hono();

  // Order matters: the Host check runs first so a rebinding page never reaches a route.
  app.use('*', hostGuard(deps.host ?? bindHost()));
  app.use('*', securityHeaders);
  app.use('/api/*', csrfGuard);
  // Limits read config when the app is built, so the load-test server can lift them first.
  const { limits } = config;
  app.use('/api/chat', rateLimit(limits.chatPerMinute), sizeLimit(limits.chatBodyBytes));
  app.use('/api/import', rateLimit(limits.importPerMinute), sizeLimit(limits.importBodyBytes));

  // ---------- UI ----------
  const page = (file: string, type: string) => (c: any) => c.body(readFileSync(new URL(`../public/${file}`, import.meta.url)), 200, { 'content-type': type });
  app.get('/', page('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', page('app.js', 'text/javascript; charset=utf-8'));
  app.get('/cite.js', page('cite.js', 'text/javascript; charset=utf-8'));
  app.get('/styles.css', page('styles.css', 'text/css; charset=utf-8'));
  app.get('/vendor/marked.js', (c) => c.body(readFileSync(require.resolve('marked')), 200, { 'content-type': 'text/javascript' }));

  // ---------- API ----------
  app.get('/api/health', (c) =>
    c.json({ ok: missingKeys().length === 0, missing: missingKeys(), models: modelChain.map(specName), clockOverride: config.allowClockOverride }),
  );

  app.get('/api/conversations', (c) => c.json(listConversations()));

  app.get('/api/conversations/:id/messages', (c) => {
    if (!getConversation(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
    return c.json(getMessages(c.req.param('id')));
  });

  app.get('/api/traces', (c) => c.json(recentTraces().map(sanitizeTrace)));

  const ChatBody = z.object({
    // The UI sends null for "no conversation yet" (JSON.stringify drops undefined but keeps null).
    conversationId: conversationIdField,
    message: z.string().trim().min(1).max(8000).refine(hasVisibleText, 'message is empty'),
    timeZone: timeZoneField,
    now: timeField('now')
      .nullish()
      .transform((v) => v ?? undefined),
  });

  app.post('/api/chat', async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    // With an injected model only the search key matters, and search already degrades gracefully without it.
    const missing = deps.model ? [] : missingKeys();
    if (missing.length) return c.json({ error: `Missing ${missing.join(', ')} in .env` }, 500);

    const { conversationId, message, timeZone, now } = parsed.data;
    const tz = timeZone ?? config.defaultTimezone;
    const abort = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => abort.abort());

    return streamSSE(c, async (stream) => {
      const queue: Promise<unknown>[] = [];
      const send = (e: { type: string }) => queue.push(stream.writeSSE({ event: e.type, data: JSON.stringify(e) }));
      try {
        await inConversationOrder(conversationId, abort.signal, () =>
          runTurn({ conversationId, text: message, now: resolveNow(now), timeZone: tz, signal: abort.signal, emit: send, model: deps.model }),
        );
      } catch (err) {
        // Anything runTurn did not handle (a database or recall error): the client must get an
        // error event, never a stream that just ends with no answer. Detail stays in the log.
        console.warn(`turn crashed: ${logDetail(err)}`);
        send({ type: 'error', code: 'internal', message: publicMessage('internal') } as { type: string });
      }
      await Promise.all(queue);
    });
  });

  /**
   * Import past conversation turns with their original timestamps. This is how a
   * test harness (or a user migrating history) seeds "what I asked on Monday".
   */
  const ImportBody = z.object({
    conversationId: conversationIdField,
    title: z.string().max(200, 'title must be at most 200 characters').optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1).max(config.limits.importMaxMessageChars).refine(hasVisibleText, 'message content is empty'),
          at: timeField('at'),
        }),
      )
      .min(1)
      .max(config.limits.importMaxMessages),
  });

  app.post('/api/import', async (c) => {
    if (!config.allowClockOverride) return c.json({ error: 'import disabled (set ALLOW_CLOCK_OVERRIDE=true to enable)' }, 403);
    const parsed = ImportBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    const { messages, title } = parsed.data;
    const times = messages.map((m) => new Date(m.at).getTime());
    if (times.some(Number.isNaN)) return c.json({ error: 'every message needs a valid ISO "at" timestamp' }, 400);
    const conv =
      (parsed.data.conversationId && getConversation(parsed.data.conversationId)) ||
      createConversation(title ?? messages[0].content.slice(0, 60), Math.min(...times), parsed.data.conversationId);
    messages.forEach((m, i) => addMessage(conv.id, m.role, m.content, times[i]));
    return c.json({ conversationId: conv.id, imported: messages.length });
  });

  return app;
}
