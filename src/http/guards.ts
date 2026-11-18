import type { MiddlewareHandler } from 'hono';

/**
 * Request guards for a local, unauthenticated app. There is no login, so the
 * only safe callers are the user's own browser tab and their own scripts.
 * These guards keep everyone else out:
 *  - hostGuard: blocks DNS rebinding (an evil page whose domain now points at 127.0.0.1)
 *  - csrfGuard: blocks other sites from POSTing into the API through the user's browser
 *  - securityHeaders: CSP + nosniff so injected markup cannot run script
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the server only listens on loopback (the default). */
export const isLoopbackBind = (bindHost: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(bindHost.toLowerCase());

/** Hostname without the port. Handles bracketed IPv6 like "[::1]:3000". */
const hostnameOf = (host: string) => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase();

/**
 * The host the request was sent to. Node's adapter builds c.req.url from the
 * Host header, so this works for real servers and for app.request() in tests.
 */
const requestHost = (url: string, hostHeader?: string) => (hostHeader || new URL(url).host).toLowerCase();

/**
 * Rejects requests whose Host is not a loopback name. When the operator binds
 * to a non-local HOST on purpose (e.g. 0.0.0.0 inside Docker), the check is
 * turned off, because they have chosen to expose it.
 */
export function hostGuard(bindHost: string): MiddlewareHandler {
  const enforce = isLoopbackBind(bindHost);
  return async (c, next) => {
    if (enforce && !LOCAL_HOSTS.has(hostnameOf(requestHost(c.req.url, c.req.header('host'))))) {
      return c.json({ error: 'host not allowed' }, 403);
    }
    await next();
  };
}

/**
 * For state-changing API calls: JSON only (a cross-site <form> or a
 * "simple" fetch cannot send application/json without a CORS preflight, which
 * we never approve), and Origin, when present, must match the Host.
 * Requests with no Origin (curl, scripts, tests) are allowed.
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const type = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return c.json({ error: 'content-type must be application/json' }, 415);
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'cross-site request blocked' }, 403);
  const origin = c.req.header('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" (sandboxed iframe, file://) or garbage: treat as foreign.
    }
    if (originHost !== requestHost(c.req.url, c.req.header('host'))) return c.json({ error: 'cross-origin request blocked' }, 403);
  }
  await next();
};

/** No inline script or style is used by the UI, so 'self' is enough everywhere. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Content-Security-Policy', CSP);
  c.header('X-Content-Type-Options', 'nosniff');
};
