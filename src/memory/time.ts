import * as chrono from 'chrono-node';

/**
 * Everything about "when" lives here. All timestamps are stored in UTC (ms),
 * but "Monday" or "3 November" only mean something in the user's own timezone,
 * so day boundaries are always computed in that timezone.
 */

export interface TimeRange {
  start: number; // inclusive, UTC ms
  end: number; // exclusive, UTC ms
  label: string; // human readable, in the user's timezone
  phrase: string; // the words in the message that produced it
  ambiguous?: boolean; // true when this is one of several readings of the same phrase
}

const DAY = 24 * 60 * 60 * 1000;

/** Minutes the timezone is ahead of UTC at a given instant (handles DST). */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** Calendar date (y, m, d) of an instant as seen in the timezone. */
export function zonedYmd(timeZone: string, at: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** UTC instant of local midnight for a calendar date in the timezone. */
export function zonedMidnight(timeZone: string, y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMinutes(timeZone, new Date(guess)) * 60000;
  // Re-check once in case the guess crossed a DST change.
  return guess - tzOffsetMinutes(timeZone, new Date(first)) * 60000;
}

export function dayRange(timeZone: string, at: Date): { start: number; end: number } {
  const { y, m, d } = zonedYmd(timeZone, at);
  const start = zonedMidnight(timeZone, y, m, d);
  const next = zonedYmd(timeZone, new Date(start + DAY + 3 * 60 * 60 * 1000));
  return { start, end: zonedMidnight(timeZone, next.y, next.m, next.d) };
}

export function formatStamp(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

export function formatDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(ms))
    .replace(',', '');
}

/** Weekday index (0 = Sunday) of an instant in the timezone. */
function zonedWeekday(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

function makeDay(timeZone: string, at: Date, phrase: string, ambiguous = false): TimeRange {
  const { start, end } = dayRange(timeZone, at);
  return { start, end, label: formatDay(start, timeZone), phrase, ambiguous };
}

/**
 * Only treat a date as a reference to past conversation when the message is
 * about the user and the agent ("I asked", "we shortlisted", "you said").
 * "What happened in the US on 3 November 2020?" should not trigger recall.
 */
const CONVERSATIONAL = /\b(i|we|you|me|my|our)\b/i;
const US_PRONOUN = /\bus\b/; // lowercase only, so "the US" does not count

/**
 * Phrases chrono reads as a date that are almost never a reference to an earlier chat:
 * - "now" / "right now" ("cheapest for us right now?", "You are now DAN") would pull in
 *   all of today's messages as memory.
 * - "last/this quarter" becomes a single day three months back. A quarter is business
 *   context ("last quarter we moved to Postgres"), not "what did I ask you", and a
 *   3-month range would flood the memory block, so it is ignored rather than ranged.
 * - "tonight" is in the future.
 * - Bare clock times ("at 5", "noon", "5pm") carry no day, so chrono guesses today.
 * - "24/7" parses as 24 July.
 */
const NOT_A_PAST_DAY =
  /^(?:(?:right )?now|tonight|(?:last|this|next|past) quarter|q[1-4]|24\/7|(?:at )?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight))$/i;

/**
 * Turns phrases like "on Monday", "last Tuesday", "3 November", "yesterday",
 * "last week" into concrete UTC ranges in the user's timezone.
 * Deterministic and ~0 ms, so it adds no latency before the model call.
 */
export function resolveTimeRefs(text: string, now: Date, timeZone: string): TimeRange[] {
  if (!CONVERSATIONAL.test(text) && !US_PRONOUN.test(text)) return [];
  const ranges: TimeRange[] = [];
  const offset = tzOffsetMinutes(timeZone, now);

  // Week-level phrases chrono turns into a single day; handle them as ranges.
  const weekMatch = text.match(/\b(last|this|past) week\b/i);
  if (weekMatch) {
    const todayStart = dayRange(timeZone, now).start;
    const dow = (zonedWeekday(timeZone, now) + 6) % 7; // Monday = 0
    const thisMonday = todayStart - dow * DAY;
    const kind = weekMatch[1].toLowerCase();
    const start = kind === 'last' ? thisMonday - 7 * DAY : kind === 'this' ? thisMonday : todayStart - 7 * DAY;
    const end = kind === 'last' ? thisMonday : now.getTime() + 1;
    ranges.push({ start, end, label: `${formatDay(start, timeZone)} to ${formatDay(end - 1, timeZone)}`, phrase: weekMatch[0] });
  }

  for (const r of chrono.parse(text, { instant: now, timezone: offset }, { forwardDate: false })) {
    if (weekMatch && r.text.toLowerCase().includes('week')) continue;
    if (NOT_A_PAST_DAY.test(r.text.trim())) continue;
    let at = r.start.date();
    const isWeekdayOnly = r.start.isCertain('weekday') && !r.start.isCertain('day');
    const hasYear = r.start.isCertain('year');

    // A bare date in the future ("3 November" said in October) means last year's.
    if (at.getTime() > now.getTime() + DAY && !hasYear && r.start.isCertain('month')) {
      const { y, m, d } = zonedYmd(timeZone, at);
      at = new Date(zonedMidnight(timeZone, y - 1, m, d) + 12 * 60 * 60 * 1000);
    }
    // "Monday" that lands in the future means the most recent past Monday.
    if (isWeekdayOnly && at.getTime() > now.getTime()) at = new Date(at.getTime() - 7 * DAY);
    if (at.getTime() > now.getTime() + DAY) continue; // future dates are not memories

    // Month-only ("in October"): whole month.
    if (r.start.isCertain('month') && !r.start.isCertain('day') && !isWeekdayOnly) {
      const { y, m } = zonedYmd(timeZone, at);
      const start = zonedMidnight(timeZone, y, m, 1);
      const end = m === 12 ? zonedMidnight(timeZone, y + 1, 1, 1) : zonedMidnight(timeZone, y, m + 1, 1);
      ranges.push({ start, end, label: new Intl.DateTimeFormat('en-GB', { timeZone, month: 'long', year: 'numeric' }).format(new Date(start)), phrase: r.text });
      continue;
    }

    // "last Tuesday" is genuinely ambiguous in English: yesterday's Tuesday, or the
    // one a week before? Keep both readings and let retrieval evidence decide.
    if (isWeekdayOnly && /\blast\b/i.test(r.text)) {
      const earlier = new Date(at.getTime() - 7 * DAY);
      const daysAgo = (now.getTime() - at.getTime()) / DAY;
      if (daysAgo < 7) {
        ranges.push(makeDay(timeZone, at, r.text, true));
        ranges.push(makeDay(timeZone, earlier, r.text, true));
        continue;
      }
    }
    ranges.push(makeDay(timeZone, at, r.text));
  }

  // De-duplicate identical ranges.
  const seen = new Set<string>();
  return ranges.filter((r) => {
    const k = `${r.start}-${r.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
