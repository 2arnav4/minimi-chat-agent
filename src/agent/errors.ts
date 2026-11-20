/**
 * Provider errors can carry request URLs (with ?key=...), response bodies or
 * headers. None of that may reach the browser, the stored traces or the logs
 * verbatim. The client gets a stable code and a generic sentence; the server
 * log gets the detail with anything key-shaped redacted.
 */

export type ErrorCode = 'quota' | 'model_unavailable' | 'auth' | 'timeout' | 'empty_answer' | 'internal';

const PUBLIC_MESSAGES: Record<ErrorCode, string> = {
  quota: 'The model is out of quota or rate-limited right now. Try again in a minute.',
  model_unavailable: 'The model is overloaded or unavailable right now. Try again shortly.',
  auth: 'The model rejected the API key. Check the key in .env.',
  timeout: 'The model did not respond in time. Try again.',
  empty_answer: 'The model returned an empty answer. Try rephrasing.',
  internal: 'Something went wrong while answering. Try again.',
};

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google / Gemini
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI
  /\btvly-[A-Za-z0-9_-]{8,}/g, // Tavily
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(key|api_key|apikey|api-key|access_token|token)=([^&\s"'<>]+)/gi,
];

/** Replace anything that looks like a credential with [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, name?: string) => (typeof name === 'string' && name ? `${name}${/bearer/i.test(name) ? ' ' : '='}[redacted]` : '[redacted]'));
  }
  return out;
}

const rawMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Map any thrown model error to a stable code. Order matters: quota before unavailable (429 vs 5xx). */
export function classifyModelError(err: unknown): ErrorCode {
  const status = Number((err as { statusCode?: unknown })?.statusCode) || 0;
  const msg = rawMessage(err).toLowerCase();
  if (status === 429 || /quota|rate.?limit|resource_exhausted|too many requests/.test(msg)) return 'quota';
  if (status === 401 || status === 403 || /api key|api_key|unauthori[sz]ed|permission denied|invalid key/.test(msg)) return 'auth';
  if (/no response from model|timed? ?out|timeout|aborted/.test(msg) || (err as Error)?.name === 'TimeoutError') return 'timeout';
  if (/empty answer/.test(msg)) return 'empty_answer';
  if (status >= 500 || /overloaded|unavailable|high demand|internal error|503|502|500/.test(msg)) return 'model_unavailable';
  return 'internal';
}

export function publicMessage(code: ErrorCode): string {
  return PUBLIC_MESSAGES[code];
}

/**
 * Traces stored before codes were introduced hold raw provider text in
 * metrics.fallbacks ("model: <message>"). Rewrite those to "model: <code>" on read.
 */
export function sanitizeTrace<T>(trace: T): T {
  const fb = (trace as { metrics?: { fallbacks?: unknown } })?.metrics?.fallbacks;
  if (!Array.isArray(fb)) return trace;
  const fallbacks = fb.map((entry) => {
    const s = String(entry);
    const cut = s.indexOf(': ');
    if (cut < 0) return redactSecrets(s);
    const detail = s.slice(cut + 2);
    const code = detail in PUBLIC_MESSAGES ? detail : classifyModelError(new Error(detail));
    return `${s.slice(0, cut)}: ${code}`;
  });
  const t = trace as { metrics: object };
  return { ...t, metrics: { ...t.metrics, fallbacks } } as T;
}

/** One short, redacted line for the server log. */
export function logDetail(err: unknown, max = 300): string {
  return redactSecrets(rawMessage(err)).replace(/\s+/g, ' ').slice(0, max);
}
