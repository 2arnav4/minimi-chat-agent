// Answer rendering helpers, shared by the browser UI, the server and the tests.
//
// linkCitations turns "[3]" / "[3, 7]" in rendered answer HTML into citation links.
// Only text between tags is touched: never inside a tag (an href or title
// that happens to contain "[1]"), and never inside <a>, <code> or <pre>
// (a link label, an inline code span or a code block keep their literal text).
// Assumes the input is HTML produced by marked with raw HTML escaped, so
// every "<" in it starts a real tag.

const CITE = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
const SKIP = new Set(['a', 'code', 'pre']);

/**
 * @param {string} html
 * @param {(n: number) => string | null} link returns the HTML for citation n, or null to leave "[n]" as text
 * @returns {string}
 */
export function linkCitations(html, link) {
  const parts = html.split(/(<[^>]*>)/);
  let skipDepth = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('<')) {
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(part);
      if (m && SKIP.has(m[2].toLowerCase()) && !part.endsWith('/>')) skipDepth += m[1] ? -1 : 1;
      if (skipDepth < 0) skipDepth = 0;
      continue;
    }
    if (skipDepth > 0 || !part.includes('[')) continue;
    parts[i] = part.replace(CITE, (whole, group) =>
      group
        .split(',')
        .map((x) => {
          const n = Number(x.trim());
          return link(n) ?? `[${n}]`;
        })
        .join(''),
    );
  }
  return parts.join('');
}

// An inline link or image: "[label](url)" or "[label](url "title")", where the label may hold
// one level of nested brackets, as in "[label [8]](url)".
const INLINE_LINK = /!?\[(?:[^[\]]|\[[^[\]]*\])*\]\([^)\s]*(?:\s+"[^"]*")?\)/g;

/**
 * Citation numbers in raw markdown, by the same rule the UI uses when linking:
 * never inside code spans, code blocks, or links (label, URL or title), so the
 * server never stores a source the reader cannot see cited.
 */
export function citedNumbers(markdown) {
  const text = String(markdown)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(INLINE_LINK, ' ');
  const out = new Set();
  for (const m of text.matchAll(CITE)) for (const n of m[1].split(',')) out.add(Number(n.trim()));
  return out;
}

const SAFE_PROTOCOL = /^(https?:|mailto:)$/i;

/** Absolute URL for an http(s)/mailto link, or null for anything else (javascript:, data:, garbage). */
export function safeHref(href, base) {
  try {
    const u = new URL(href, base);
    return SAFE_PROTOCOL.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * marked renderer overrides for model answers. The model may echo web content,
 * so: raw HTML is shown as text; links only keep http(s)/mailto targets; and
 * images are never loaded. A remote <img> fetches on render with no click, so
 * a prompt-injected answer could beacon data out in its URL; it becomes a
 * plain link with the alt text instead (inline and reference-style alike).
 * @param {string} [base] base URL for relative links (location.href in the browser)
 */
export function answerRenderer(base) {
  return {
    html: (t) => esc(t.text ?? t.raw ?? ''),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const url = safeHref(href, base);
      // Unsafe target: keep the label inside an inert <a> (no href) so linkCitations,
      // like citedNumbers, still treats it as a link label.
      if (!url) return `<a class="unsafe-link">${label}</a>`;
      return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, title, text }) {
      const url = safeHref(href, base);
      const label = esc(text || 'image');
      if (!url || !/^https?:/i.test(url)) return label;
      return `<a class="image-link" href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  };
}

/**
 * Citation markup for answer n. sources === null means "not known yet" (still
 * streaming): leave "[n]" as plain text. Once sources are known, a number with
 * no matching source is shown muted, so a made-up citation does not look real.
 */
export function citationHtml(n, sources, base) {
  if (sources == null) return null;
  const s = sources.find((x) => x.n === n);
  const href = s && safeHref(s.url, base);
  if (href) return `<a class="cite" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(s.title ?? '')}">[${n}]</a>`;
  return `<span class="cite-missing" title="No source with this number in this answer">[${n}]</span>`;
}

/** Label for the waiting line while a turn shows no progress, or null when none is needed. */
export function waitingLabel(idleMs) {
  if (idleMs > 15000) return 'Still working, the model is slow…';
  if (idleMs > 1500) return 'Thinking…';
  return null;
}
