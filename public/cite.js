// Turns "[3]" / "[3, 7]" in rendered answer HTML into citation links.
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

/** Citation numbers in raw markdown, ignoring code spans, code blocks and link targets. */
export function citedNumbers(markdown) {
  const text = String(markdown)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)\s]*(\s+"[^"]*")?\)/g, '] ');
  const out = new Set();
  for (const m of text.matchAll(CITE)) for (const n of m[1].split(',')) out.add(Number(n.trim()));
  return out;
}
