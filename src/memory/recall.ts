import { resolveTimeRefs, formatStamp, type TimeRange } from './time.js';
import { messagesInRange, searchMessages, neighbour, historyBounds, type StoredMessage } from './store.js';

/**
 * Recall runs inside the harness, before the model is called. The challenge
 * allows one tool (web search), so memory cannot be a tool the model calls.
 * That is also faster: no extra model round trip to "decide to look it up".
 *
 * Pipeline: resolve dates in the message -> pull every message from those
 * days -> rank by keyword match -> pair each question with its answer ->
 * hand the model a compact, timestamped transcript.
 */

export interface Recall {
  block: string | null; // text injected into the model's context, or null if nothing relevant
  ranges: TimeRange[];
  matched: number; // how many past messages were included
  mode: 'date' | 'topic' | 'none';
}

/** Phrases that signal the user is referring to an earlier exchange. */
const MEMORY_CUE =
  /\b(you (said|told|suggested|recommended|answered|mentioned|gave)|i (ask|asked|told|said|mentioned)|we (discuss|discussed|talk|talked|shortlist|shortlisted|decide|decided|compare|compared|look at|looked at|pick|picked|choose|chose)|our (chat|conversation)|earlier|last time|previously|before|remember|recall|still (correct|true|right|valid)|since then|changed since|shortlist)/i;

const STOP = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to us was we were what when where which who why will with would you your
  about ask asked asking tell told say said answer answered still correct right true today now ago since then again any anything something some
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december
  last this next week weeks month months year years day days yesterday morning evening night earlier before previously time
  jan feb mar apr jun jul aug sep sept oct nov dec st nd rd th`.split(/\s+/),
);

export function keywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, 12);
}

export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t}"`).join(' OR ');
}

const MAX_MESSAGES = 24;
const MAX_CHARS_PER_MESSAGE = 1800;

/** Expand hits so every user question comes with the answer it got (and vice versa). */
function withPairs(hits: StoredMessage[]): StoredMessage[] {
  const byId = new Map<number, StoredMessage>();
  for (const h of hits) {
    byId.set(h.id, h);
    const pair = neighbour(h, h.role === 'user' ? 'next' : 'prev');
    if (pair && pair.role !== h.role) byId.set(pair.id, pair);
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

function render(messages: StoredMessage[], timeZone: string): string {
  return messages
    .map((m) => {
      const body = m.content.length > MAX_CHARS_PER_MESSAGE ? m.content.slice(0, MAX_CHARS_PER_MESSAGE) + ' [...]' : m.content;
      const src = m.sources.length ? `\n  Sources used then: ${m.sources.slice(0, 6).map((s) => s.url).join(', ')}` : '';
      // A stopped answer stays visible (it shows what was said, and keeps the question paired
      // with a reply) but is labelled so the model never treats it as a complete answer.
      const who = m.role === 'user' ? 'User' : m.status === 'cancelled' ? 'Assistant (stopped by the user before finishing, incomplete)' : 'Assistant';
      return `[${formatStamp(m.createdAt, timeZone)}] ${who}: ${body}${src}`;
    })
    .join('\n');
}

export function recall(text: string, now: Date, timeZone: string, excludeIds: number[] = []): Recall {
  const ranges = resolveTimeRefs(text, now, timeZone);
  const terms = keywords(text);
  const q = ftsQuery(terms);
  const exclude = new Set(excludeIds);
  const notExcluded = (m: StoredMessage) => !exclude.has(m.id);

  if (ranges.length) {
    const sections: string[] = [];
    const notes: string[] = [];
    let matched = 0;

    // Score each candidate range by how well its messages match the topic.
    const scored = ranges.map((r) => {
      const all = messagesInRange(r.start, r.end, excludeIds);
      const hits = terms.length ? searchMessages(q, { start: r.start, end: r.end, limit: 40 }).filter(notExcluded) : [];
      return { r, all, hits };
    });

    // For ambiguous readings ("last Tuesday"), prefer the day whose messages match the topic.
    const ambiguous = scored.filter((s) => s.r.ambiguous);
    let keep = scored;
    if (ambiguous.length > 1) {
      const withHits = ambiguous.filter((s) => s.hits.length);
      const withAny = ambiguous.filter((s) => s.all.length);
      const chosen = withHits.length ? withHits : withAny.length ? withAny : ambiguous;
      keep = [...scored.filter((s) => !s.r.ambiguous), ...chosen];
      const phrase = ambiguous[0].r.phrase;
      notes.push(
        `"${phrase}" can mean ${ambiguous.map((s) => s.r.label).join(' or ')}. ` +
          (chosen.length === 1 && chosen !== ambiguous
            ? `Only ${chosen[0].r.label} has a matching conversation, so it is most likely that one.`
            : chosen.length > 1 && chosen !== ambiguous
              ? `Both have conversations; showing both.`
              : `Neither has a recorded conversation.`),
      );
    }

    for (const { r, all, hits } of keep) {
      if (!all.length) {
        sections.push(`--- ${r.label} ("${r.phrase}") ---\nNo messages recorded on this date.`);
        continue;
      }
      // Small days are included whole (order matters for "what did I ask"); big days are filtered by topic.
      const picked = all.length <= 16 ? all : withPairs(hits.length ? hits.slice(0, 10) : all.slice(0, 8));
      const slice = picked.slice(0, MAX_MESSAGES);
      matched += slice.length;
      sections.push(`--- ${r.label} ("${r.phrase}"), ${all.length} message(s) that day ---\n${render(slice, timeZone)}`);
    }

    // Nothing on the requested date: offer the closest topic match from any date, clearly labelled.
    if (matched === 0 && terms.length) {
      const near = withPairs(searchMessages(q, { limit: 4 }).filter(notExcluded)).slice(0, 6);
      if (near.length) {
        matched += near.length;
        sections.push(`--- Nothing on that date. Closest topic match from other dates (say so if you use it) ---\n${render(near, timeZone)}`);
      }
    }

    const { first, count } = historyBounds();
    const header = `History on record: ${count} message(s)${first ? `, earliest ${formatStamp(first, timeZone)}` : ''}.`;
    return { block: [header, ...notes, ...sections].join('\n\n'), ranges, matched, mode: 'date' };
  }

  if (MEMORY_CUE.test(text) && terms.length) {
    const hits = withPairs(searchMessages(q, { limit: 8 }).filter(notExcluded)).slice(0, 12);
    if (!hits.length) return { block: 'No earlier messages match this topic.', ranges, matched: 0, mode: 'topic' };
    return { block: `Earlier messages that match this topic:\n${render(hits, timeZone)}`, ranges, matched: hits.length, mode: 'topic' };
  }

  return { block: null, ranges, matched: 0, mode: 'none' };
}
