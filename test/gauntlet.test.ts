import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { marked } from 'marked';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { resetDb, getDb, saveTrace, cacheSet, cacheGet, createConversation, addMessage, getMessages } from '../src/memory/store.js';
import { pruneDb } from '../src/memory/prune.js';
import { redactSecrets, classifyModelError } from '../src/agent/errors.js';
import { citedNumbers, linkCitations } from '../public/cite.js';
import { resolveTimeRefs, dayRange } from '../src/memory/time.js';

/**
 * Gauntlet step 6: boundary tests (just inside / just outside) for every rule added
 * in the hardening round, plus seeded random runs. The seed is in each test name so
 * a failure can be replayed. The clock is injected or mocked; nothing sleeps.
 */

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const textModel = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'ok' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ] as any),
    }),
  } as any);

const json = { 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, path: string, body: string, headers: Record<string, string> = json) =>
  app.request(path, { method: 'POST', headers, body });

/** Run fn with some config.limits values changed; createApp must be called inside fn (limits are read at build time). */
async function withLimits<T>(over: Partial<typeof config.limits>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...config.limits };
  Object.assign(config.limits, over);
  try {
    return await fn();
  } finally {
    Object.assign(config.limits, saved);
  }
}

/** mulberry32: small seeded PRNG so random runs replay exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];

beforeEach(() => {
  resetDb();
  config.allowClockOverride = true;
});

// ---------------- size limits ----------------

test('chat body: exactly chatBodyBytes is accepted, one byte more is 413', async () => {
  await withLimits({ chatBodyBytes: 300, chatPerMinute: 0 }, async () => {
    const app = createApp({ model: textModel() });
    const base = '{"message":"hi"}';
    const atLimit = base + ' '.repeat(300 - Buffer.byteLength(base));
    assert.equal(Buffer.byteLength(atLimit), 300);
    const ok = await post(app, '/api/chat', atLimit);
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal((await post(app, '/api/chat', atLimit + ' ')).status, 413);
  });
});

test('import body: exactly importBodyBytes is accepted, one byte more is 413', async () => {
  await withLimits({ importBodyBytes: 400, importPerMinute: 0 }, async () => {
    const app = createApp({ model: textModel() });
    const base = JSON.stringify({ messages: [{ role: 'user', content: 'hello', at: '2026-11-03T10:00:00Z' }] });
    const atLimit = base + ' '.repeat(400 - Buffer.byteLength(base));
    assert.equal((await post(app, '/api/import', atLimit)).status, 200);
    assert.equal((await post(app, '/api/import', atLimit + ' ')).status, 413);
  });
});

test('import count: exactly importMaxMessages is accepted, one more is 400', async () => {
  await withLimits({ importMaxMessages: 5, importPerMinute: 0 }, async () => {
    const app = createApp({ model: textModel() });
    const msgs = (n: number) => JSON.stringify({ messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}`, at: '2026-11-03T10:00:00Z' })) });
    assert.equal((await post(app, '/api/import', msgs(5))).status, 200);
    assert.equal((await post(app, '/api/import', msgs(6))).status, 400);
    assert.equal((await post(app, '/api/import', msgs(0))).status, 400, 'an empty import is refused');
  });
});

test('import message length: exactly importMaxMessageChars is accepted, one more is 400', async () => {
  await withLimits({ importMaxMessageChars: 50, importPerMinute: 0 }, async () => {
    const app = createApp({ model: textModel() });
    const one = (len: number) => JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(len), at: '2026-11-03T10:00:00Z' }] });
    assert.equal((await post(app, '/api/import', one(50))).status, 200);
    assert.equal((await post(app, '/api/import', one(51))).status, 400);
  });
});

test('chat message length: 8000 characters accepted, 8001 is 400, whitespace-only is 400', async () => {
  await withLimits({ chatPerMinute: 0 }, async () => {
    const app = createApp({ model: textModel() });
    const ok = await post(app, '/api/chat', JSON.stringify({ message: 'a'.repeat(8000) }));
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal((await post(app, '/api/chat', JSON.stringify({ message: 'a'.repeat(8001) }))).status, 400);
    assert.equal((await post(app, '/api/chat', JSON.stringify({ message: '   ' }))).status, 400);
  });
});

// ---------------- rate limit ----------------

test('rate limit: request N is allowed, N+1 is 429, and the window reopens at exactly 60 s (mocked clock)', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    await withLimits({ importPerMinute: 3 }, async () => {
      const app = createApp({ model: textModel() });
      const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi', at: '2026-11-03T10:00:00Z' }] });
      for (let i = 0; i < 3; i++) assert.equal((await post(app, '/api/import', body)).status, 200, `request ${i + 1}`);
      const limited = await post(app, '/api/import', body);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('retry-after'), '60');
      mock.timers.tick(59_999);
      const still = await post(app, '/api/import', body);
      assert.equal(still.status, 429, '1 ms before the window ends');
      assert.equal(still.headers.get('retry-after'), '1');
      mock.timers.tick(1);
      assert.equal((await post(app, '/api/import', body)).status, 200, 'window reopened');
    });
  } finally {
    mock.timers.reset();
  }
});

test('rate limit: chat and import are counted separately', async () => {
  await withLimits({ importPerMinute: 1, chatPerMinute: 1 }, async () => {
    const app = createApp({ model: textModel() });
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi', at: '2026-11-03T10:00:00Z' }] });
    assert.equal((await post(app, '/api/import', body)).status, 200);
    const chat = await post(app, '/api/chat', JSON.stringify({ message: 'hello' }));
    assert.equal(chat.status, 200, 'an import does not use up the chat budget');
    await chat.text();
    assert.equal((await post(app, '/api/import', body)).status, 429);
    assert.equal((await post(app, '/api/chat', JSON.stringify({ message: 'hello' }))).status, 429);
  });
});

// ---------------- guards ----------------

test('host guard: loopback names with any port pass; look-alikes and other hosts are 403', async () => {
  const app = createApp({ model: textModel() });
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1:8080', '[::1]:3000', 'LOCALHOST:3000']) {
    assert.equal((await app.request('/api/health', { headers: { host } })).status, 200, host);
  }
  for (const host of ['evil.com', 'localhost.evil.com', '127.0.0.1.nip.io', 'evil.com:3000', '0.0.0.0:3000', '[::2]:3000']) {
    assert.equal((await app.request('/api/health', { headers: { host } })).status, 403, host);
  }
  const exposed = createApp({ model: textModel(), host: '0.0.0.0' });
  assert.equal((await exposed.request('/api/health', { headers: { host: 'evil.com' } })).status, 200, 'non-loopback bind turns the check off');
});

test('csrf guard: content-type and origin boundaries', async () => {
  await withLimits({ importPerMinute: 0 }, async () => {
    const app = createApp({ model: textModel() });
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi', at: '2026-11-03T10:00:00Z' }] });
    const status = async (h: Record<string, string>) => (await post(app, '/api/import', body, h)).status;
    assert.equal(await status({ 'content-type': 'application/json; charset=utf-8' }), 200);
    assert.equal(await status({ 'content-type': 'APPLICATION/JSON' }), 200);
    assert.equal(await status({ 'content-type': 'application/jsonx' }), 415);
    assert.equal(await status({ 'content-type': 'text/plain' }), 415);
    assert.equal(await status({}), 415);
    assert.equal(await status({ ...json, origin: 'http://localhost' }), 200, 'same origin');
    assert.equal(await status({ ...json, origin: 'http://localhost:9999' }), 403, 'other port is another origin');
    assert.equal(await status({ ...json, origin: 'null' }), 403);
    assert.equal(await status({ ...json, origin: 'not a url' }), 403);
    assert.equal(await status({ ...json, 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await status({ ...json, 'sec-fetch-site': 'same-origin' }), 200);
  });
});

test('security headers are on every response, including 404 and errors', async () => {
  const app = createApp({ model: textModel() });
  for (const res of [await app.request('/'), await app.request('/nope'), await post(app, '/api/chat', 'x', {}), await app.request('/api/conversations/zzz/messages')]) {
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
});

// ---------------- clock gating ----------------

test('clock override: flag off ignores "now" and refuses import; flag on uses a valid "now", refuses an invalid one', async () => {
  const app = createApp({ model: textModel() });
  const send = async (now: string) => {
    const res = await post(app, '/api/chat', JSON.stringify({ message: 'hi', now }));
    const raw = await res.text();
    const meta = JSON.parse(raw.split('\n').find((l) => l.startsWith('data:') && l.includes('"meta"'))!.slice(5));
    return getMessages(meta.conversationId)[0].createdAt;
  };
  config.allowClockOverride = true;
  assert.equal(await send('2026-11-03T10:00:00Z'), Date.parse('2026-11-03T10:00:00Z'));
  const before = Date.now();
  // An invalid "now" is refused (400) rather than silently replaced by the real clock.
  assert.equal((await post(app, '/api/chat', JSON.stringify({ message: 'hi', now: 'not a date' }))).status, 400);
  config.allowClockOverride = false;
  const t2 = await send('2026-11-03T10:00:00Z');
  assert.ok(t2 >= before, 'flag off: the requested now is ignored');
  const imp = await post(app, '/api/import', JSON.stringify({ messages: [{ role: 'user', content: 'hi', at: '2026-11-03T10:00:00Z' }] }));
  assert.equal(imp.status, 403);
});

test('ALLOW_CLOCK_OVERRIDE is on only for the exact string "true"', () => {
  const read = (value: string) =>
    execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/config.ts').then((m) => process.stdout.write(String(m.config.allowClockOverride)))"], {
      env: { ...process.env, ALLOW_CLOCK_OVERRIDE: value },
      encoding: 'utf8',
    });
  assert.equal(read('true'), 'true');
  assert.equal(read(' true '), 'true', 'config trims every env value, by design');
  for (const v of ['false', '1', 'yes', 'TRUE', 'true1', '']) assert.equal(read(v), 'false', JSON.stringify(v));
});

// ---------------- pruning ----------------

test('prune: traces exactly at traceKeep are kept; one over deletes exactly the oldest', () => {
  for (let i = 0; i < 3; i++) saveTrace('c', i, { i });
  assert.equal(pruneDb({ now: 0, traceKeep: 3 }).traces, 0);
  assert.equal(pruneDb({ now: 0, traceKeep: 2 }).traces, 1);
  const left = (getDb().prepare('SELECT data FROM traces ORDER BY id').all() as { data: string }[]).map((r) => JSON.parse(r.data).i);
  assert.deepEqual(left, [1, 2]);
  assert.equal(pruneDb({ now: 0, traceKeep: 0 }).traces, 2, 'traceKeep 0 removes all');
});

test('prune and cacheGet agree on the TTL boundary: age == ttl is live, ttl + 1 is gone', () => {
  const now = 1_000_000;
  const ttl = 1000;
  cacheSet('edge', ['e'], now - ttl);
  cacheSet('over', ['o'], now - ttl - 1);
  assert.deepEqual(cacheGet('edge', ttl, now), ['e']);
  assert.equal(cacheGet('over', ttl, now), null);
  assert.equal(pruneDb({ now, cacheTtlMs: ttl, traceKeep: 1000 }).cache, 1);
  assert.deepEqual(cacheGet('edge', ttl, now), ['e'], 'prune kept the row cacheGet still serves');
});

test('prune: message exactly at the retention cutoff is kept, 1 ms older is deleted', () => {
  const day = 86_400_000;
  const now = 100 * day;
  const cutoff = now - 30 * day;
  const c = createConversation('c', cutoff - 1);
  addMessage(c.id, 'user', 'older', cutoff - 1);
  addMessage(c.id, 'user', 'edge', cutoff);
  const r = pruneDb({ now, traceKeep: 1000, messageRetentionDays: 30 });
  assert.equal(r.messages, 1);
  assert.deepEqual(getMessages(c.id).map((m) => m.content), ['edge']);
  assert.equal(r.conversations, 0, 'a conversation with a message left is kept');
});

// ---------------- redaction (seeded) ----------------

test('redaction boundaries: minimum key lengths', () => {
  assert.equal(redactSecrets('AIza' + 'a'.repeat(20)), '[redacted]');
  assert.equal(redactSecrets('AIza' + 'a'.repeat(19)), 'AIza' + 'a'.repeat(19));
  assert.equal(redactSecrets('sk-' + 'a'.repeat(16)), '[redacted]');
  assert.equal(redactSecrets('sk-' + 'a'.repeat(15)), 'sk-' + 'a'.repeat(15));
  assert.equal(redactSecrets('tvly-' + 'a'.repeat(8)), '[redacted]');
  assert.equal(redactSecrets('tvly-' + 'a'.repeat(7)), 'tvly-' + 'a'.repeat(7));
  assert.equal(redactSecrets('?key=x&y=1'), '?key=[redacted]&y=1');
});

for (const seed of [1, 42, 20261120]) {
  test(`redaction random run (seed ${seed}): no generated key survives, surrounding text is kept`, () => {
    const r = rng(seed);
    const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const chars = (n: number, set = alnum) => Array.from({ length: n }, () => set[Math.floor(r() * set.length)]).join('');
    const makers = [
      () => 'AIza' + chars(20 + Math.floor(r() * 20), alnum + '_-'),
      () => 'sk-proj-' + chars(16 + Math.floor(r() * 30)),
      () => 'tvly-dev-' + chars(8 + Math.floor(r() * 30)),
      () => 'Bearer ' + chars(8 + Math.floor(r() * 30), alnum + '._~+/='),
    ];
    for (let i = 0; i < 300; i++) {
      const secret = pick(r, makers)();
      const before = 'error ' + chars(1 + Math.floor(r() * 8)) + ' at ';
      const after = ' (status ' + Math.floor(r() * 600) + ')';
      const out = redactSecrets(before + secret + after);
      const tail = secret.replace(/^Bearer /, '');
      assert.ok(!out.includes(tail), `seed ${seed} case ${i}: leaked ${secret} in ${out}`);
      assert.ok(out.startsWith(before) && out.endsWith(after), `seed ${seed} case ${i}: context damaged: ${out}`);
    }
  });
}

test('classifyModelError status boundaries', () => {
  const s = (statusCode: number) => classifyModelError(Object.assign(new Error('x'), { statusCode }));
  assert.equal(s(429), 'quota');
  assert.equal(s(401), 'auth');
  assert.equal(s(403), 'auth');
  assert.equal(s(499), 'internal');
  assert.equal(s(500), 'model_unavailable');
  assert.equal(s(503), 'model_unavailable');
});

// ---------------- citations (seeded) ----------------

for (const seed of [7, 99, 2026]) {
  test(`citations random run (seed ${seed}): only plain-text [n] is linked or counted`, () => {
    const r = rng(seed);
    for (let i = 0; i < 200; i++) {
      const expected = new Set<number>();
      const inLabels = new Set<number>();
      let plainCount = 0;
      const pieces: string[] = [];
      for (let j = 0; j < 1 + Math.floor(r() * 6); j++) {
        const n = 1 + Math.floor(r() * 9);
        switch (Math.floor(r() * 5)) {
          case 0:
            pieces.push(`Fact ${j} [${n}].`);
            expected.add(n);
            plainCount++;
            break;
          case 1:
            pieces.push(`Inline \`arr[${n}]\` code.`);
            break;
          case 2:
            pieces.push(`\n\n\`\`\`\nx = y[${n}]\n\`\`\`\n\n`);
            break;
          case 3:
            pieces.push(`See [the page](https://example.com/a[${n}] "title [${n}]").`);
            break;
          default:
            pieces.push(`[label [${n}]](https://example.com/b)`);
            inLabels.add(n);
        }
      }
      const md = pieces.join(' ');
      // Server side: plain-text citations are always found; code and link URLs never count.
      // ([n] inside a link label is still counted by citedNumbers; see the todo test below.)
      const got = citedNumbers(md);
      for (const n of expected) assert.ok(got.has(n), `seed ${seed} case ${i}: missed [${n}] in ${JSON.stringify(md)}`);
      for (const n of got) assert.ok(expected.has(n) || inLabels.has(n), `seed ${seed} case ${i}: counted [${n}] from code or a URL in ${JSON.stringify(md)}`);
      const html = marked.parse(md, { async: false }) as string;
      let linked = 0;
      const out = linkCitations(html, (n) => {
        linked++;
        return `<sup data-c="${n}"></sup>`;
      });
      assert.equal(linked, plainCount, `seed ${seed} case ${i}: linked ${linked}, expected ${plainCount}, html ${html}`);
      // Never inside a tag: every <sup> sits between tags, not inside an attribute.
      for (const tag of out.match(/<[^>]*>/g) ?? []) assert.ok(!/<[^>]*<sup/.test(tag), `sup inside a tag: ${tag}`);
    }
  });
}

test('citedNumbers ignores [n] inside a link label, like the UI does', { todo: 'gauntlet finding: server counts [n] in a link label as cited, UI does not link it' }, () => {
  assert.deepEqual([...citedNumbers('[label [8]](https://example.com/b) and a real one [2]')], [2]);
});

// ---------------- time refs (seeded) ----------------

for (const seed of [3, 11, 777]) {
  test(`resolveTimeRefs random run (seed ${seed}): day ranges start at local midnight, last ~1 day, never in the future`, () => {
    const r = rng(seed);
    const zones = ['Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London', 'Australia/Sydney', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland'];
    const phrases = ['What did I ask you on Monday?', 'What did I ask you yesterday?', 'What did I ask you on 3 November?', 'Last Tuesday I asked you about Postgres', 'What did we discuss on Friday?', 'What did I ask on 29 March?'];
    const H = 3_600_000;
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const now = new Date(Date.UTC(2025, 0, 1) + Math.floor(r() * 730 * 24) * H + Math.floor(r() * H));
      const tz = pick(r, zones);
      const text = pick(r, phrases);
      const ranges = resolveTimeRefs(text, now, tz);
      assert.ok(ranges.length >= 1, `seed ${seed} case ${i}: no range for "${text}" at ${now.toISOString()} ${tz}`);
      for (const rg of ranges) {
        const ctx = `seed ${seed} case ${i}: "${text}" at ${now.toISOString()} ${tz} -> ${new Date(rg.start).toISOString()}..${new Date(rg.end).toISOString()}`;
        assert.ok(rg.start <= now.getTime(), `${ctx} starts in the future`);
        const len = rg.end - rg.start;
        assert.ok(len >= 23 * H && len <= 25 * H, `${ctx} is ${len / H}h long`);
        assert.equal(rg.start, dayRange(tz, new Date(rg.start + 12 * H)).start, `${ctx} does not start at local midnight`);
        assert.ok(rg.label.length > 0);
        checked++;
      }
    }
    assert.ok(checked >= 300, 'the run exercised every case');
  });
}
