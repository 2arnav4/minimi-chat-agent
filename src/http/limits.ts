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

/**
 * Fixed-window, in-memory rate limit: at most `perMinute` requests per client per
 * minute, 429 with Retry-After past that. perMinute <= 0 turns it off.
 * In memory on purpose: one process, no login. Several instances would need a shared store.
 */
export function rateLimit(perMinute: number, windowMs = 60_000): MiddlewareHandler {
  const windows = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    if (perMinute <= 0) return next();
    const now = Date.now();
    // Bound memory: drop expired windows once the map grows.
    if (windows.size > 10_000) for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
    const key = clientKey(c);
    let w = windows.get(key);
    if (!w || now - w.start >= windowMs) windows.set(key, (w = { start: now, count: 0 }));
    if (w.count >= perMinute) {
      const retryAfter = Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
      return c.json({ error: `too many requests, retry in ${retryAfter}s` }, 429, { 'retry-after': String(retryAfter) });
    }
    w.count++;
    return next();
  };
}
