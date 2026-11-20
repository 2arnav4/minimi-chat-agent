import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/**
 * Rejects bodies over maxBytes with 413 before they are parsed. Checks the
 * Content-Length header and also counts streamed bytes, so a missing or
 * lying header does not get around it.
 */
export const sizeLimit = (maxBytes: number): MiddlewareHandler =>
  bodyLimit({ maxSize: maxBytes, onError: (c) => c.json({ error: `request body too large (limit ${maxBytes} bytes)` }, 413) });

/** Who a request counts against. The socket address when the Node server provides it, else one shared bucket. */
function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'local';
}

export interface RateLimitOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Hard cap on tracked clients; the oldest window is evicted past it. */
  maxKeys?: number;
}

/**
 * Fixed-window, in-memory rate limit: at most `perMinute` requests per client per
 * minute, 429 with Retry-After past that. perMinute <= 0 turns it off.
 * In memory on purpose: one process, no login. Several instances would need a shared store.
 * Memory stays bounded by active clients: expired windows are swept once per window,
 * and past maxKeys the oldest window is evicted (Map keeps insertion order, and a key
 * is re-inserted whenever its window restarts, so the first entry is the oldest).
 */
export function rateLimit(perMinute: number, windowMs = 60_000, opts: RateLimitOptions = {}): MiddlewareHandler & { size(): number } {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  const handler = (async (c, next) => {
    if (perMinute <= 0) return next();
    const t = now();
    if (t - lastSweep >= windowMs) {
      for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
      lastSweep = t;
    }
    const key = clientKey(c);
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      windows.delete(key);
      windows.set(key, (w = { start: t, count: 0 }));
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value as string);
    }
    if (w.count >= perMinute) {
      const retryAfter = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
      return c.json({ error: `too many requests, retry in ${retryAfter}s` }, 429, { 'retry-after': String(retryAfter) });
    }
    w.count++;
    return next();
  }) as MiddlewareHandler & { size(): number };
  handler.size = () => windows.size;
  return handler;
}

/**
 * Socket timeouts for the Node HTTP server. headersTimeout closes connections that
 * never finish sending headers (slowloris); requestTimeout caps how long the client
 * may take to send the whole request. Neither limits how long a response may stream,
 * so long SSE answers are unaffected; server.timeout (idle socket) stays 0 for the same reason.
 */
export function applyServerTimeouts(server: { headersTimeout: number; requestTimeout: number; keepAliveTimeout: number; timeout: number }) {
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 0;
  return server;
}
