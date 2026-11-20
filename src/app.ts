import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { config, missingKeys, modelChain, specName } from './config.js';
import type { LanguageModel } from 'ai';
import { runTurn } from './agent/run.js';
import { sanitizeTrace } from './agent/errors.js';
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
  if (override && config.allowClockOverride) {
    const d = new Date(override);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
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
    conversationId: z.string().nullish().transform((v) => v ?? undefined),
    message: z.string().trim().min(1).max(8000),
    timeZone: z.string().nullish().transform((v) => v ?? undefined),
    now: z.string().nullish().transform((v) => v ?? undefined),
  });

  app.post('/api/chat', async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'bad request' }, 400);
    // With an injected model only the search key matters, and search already degrades gracefully without it.
    const missing = deps.model ? [] : missingKeys();
    if (missing.length) return c.json({ error: `Missing ${missing.join(', ')} in .env` }, 500);

    const { conversationId, message, timeZone, now } = parsed.data;
    const tz = timeZone && isValidTz(timeZone) ? timeZone : config.defaultTimezone;
    const abort = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => abort.abort());

    return streamSSE(c, async (stream) => {
      const queue: Promise<unknown>[] = [];
      await runTurn({
        conversationId,
        text: message,
        now: resolveNow(now),
        timeZone: tz,
        signal: abort.signal,
        emit: (e) => queue.push(stream.writeSSE({ event: e.type, data: JSON.stringify(e) })),
        model: deps.model,
      });
      await Promise.all(queue);
    });
  });

  /**
   * Import past conversation turns with their original timestamps. This is how a
   * test harness (or a user migrating history) seeds "what I asked on Monday".
   */
  const ImportBody = z.object({
    conversationId: z.string().optional(),
    title: z.string().optional(),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(config.limits.importMaxMessageChars), at: z.string() }))
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
