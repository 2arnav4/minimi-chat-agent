import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { linkCitations, citedNumbers } from '../public/cite.js';

const link = (n: number) => (n <= 3 ? `<a class="cite" href="https://s${n}.example">[${n}]</a>` : null);

test('citations in text become links, unknown numbers stay plain', () => {
  const html = linkCitations('<p>Price is $25 [1] and $10 [2, 9].</p>', link);
  assert.equal(html, '<p>Price is $25 <a class="cite" href="https://s1.example">[1]</a> and $10 <a class="cite" href="https://s2.example">[2]</a>[9].</p>');
});

test('"[n]" inside an href, a link label or code is left alone', () => {
  const md = 'See [docs](https://x.example/a[1]b "t[2]"), [label [3]](https://y.example), `arr[1]` and\n\n```\nx[2]\n```\n\nreal [1]';
  const html = linkCitations(marked.parse(md) as string, link);
  assert.ok(html.includes('href="https://x.example/a%5B1%5Db"'), html);
  assert.equal(linkCitations('<img alt="x[1]" src="https://i.example/[2].png">', link), '<img alt="x[1]" src="https://i.example/[2].png">');
  assert.ok(html.includes('title="t[2]"'), html);
  assert.ok(html.includes('>label [3]</a>'), html);
  assert.ok(html.includes('<code>arr[1]</code>'), html);
  assert.ok(html.includes('x[2]'), html);
  assert.equal((html.match(/class="cite"/g) ?? []).length, 1, html);
});

test('server-side citedNumbers ignores code and link targets', () => {
  const cited = citedNumbers('Plan costs $25 [1][4, 5]. Ref [x](https://a.example/[2]) and `v[3]`\n```\ny[6]\n```');
  assert.deepEqual([...cited].sort(), [1, 4, 5]);
});
