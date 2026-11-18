import { marked } from '/vendor/marked.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Never render raw HTML coming from the model (it may echo web content).
// Links may only point at http(s) or mailto: a "javascript:" link in a model
// answer (echoed from a web page) would run script on click. Anything else is
// shown as its plain link text.
const SAFE_LINK = /^(https?:|mailto:)/i;
const safeHref = (href) => {
  try {
    const u = new URL(href, location.href);
    return SAFE_LINK.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
marked.use({
  renderer: {
    html: (t) => esc(t.text ?? t.raw ?? ''),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const url = safeHref(href);
      if (!url) return label;
      return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, title, text }) {
      const url = safeHref(href);
      if (!url || !/^https?:/i.test(url)) return esc(text);
      return `<img src="${esc(url)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} />`;
    },
  },
});

const $ = (id) => document.getElementById(id);
const els = { list: $('conversations'), msgs: $('messages'), empty: $('empty'), form: $('composer'), input: $('input'), send: $('send'), banner: $('banner'), clockOn: $('clock-on'), clock: $('clock') };
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
$('tz').textContent = `Your timezone: ${timeZone}`;

let conversationId = null;
let busy = false;

const fmt = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---- dev clock ----
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
els.clock.value = toLocalInput(new Date());
els.clockOn.checked = localStorage.getItem('clockOn') === '1';
if (localStorage.getItem('clock')) els.clock.value = localStorage.getItem('clock');
els.clockOn.onchange = () => localStorage.setItem('clockOn', els.clockOn.checked ? '1' : '0');
els.clock.onchange = () => localStorage.setItem('clock', els.clock.value);
const simulatedNow = () => (els.clockOn.checked && els.clock.value ? new Date(els.clock.value).toISOString() : undefined);

// ---- rendering ----
function renderAnswer(text, sources = []) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  let html = marked.parse(text || '');
  if (byN.size) {
    html = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, group) =>
      group
        .split(',')
        .map((x) => {
          const n = Number(x.trim());
          const s = byN.get(n);
          const href = s && safeHref(s.url);
          return href ? `<a class="cite" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(s.title)}">[${n}]</a>` : `[${n}]`;
        })
        .join(''),
    );
  }
  return html;
}

function addMessage(role, text, at, sources = []) {
  els.empty.hidden = true;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="stamp">${at ? esc(fmt(at)) : ''}</div><div class="activity"></div><div class="body"></div><div class="sources"></div><div class="metrics"></div>`;
  const body = div.querySelector('.body');
  if (role === 'user') body.textContent = text;
  else body.innerHTML = renderAnswer(text, sources.map((s, i) => ({ n: s.n ?? i + 1, ...s })));
  if (role === 'assistant' && sources.length) renderSources(div, sources.map((s, i) => ({ n: s.n ?? i + 1, ...s })));
  els.msgs.appendChild(div);
  els.msgs.scrollTop = els.msgs.scrollHeight;
  return div;
}

function renderSources(div, sources, numbered = true) {
  div.querySelector('.sources').innerHTML = sources
    .filter((s) => safeHref(s.url))
    .map((s) => `<a href="${esc(safeHref(s.url))}" target="_blank" rel="noopener" title="${esc(s.title)}">${numbered ? `[${s.n}] ` : ''}${esc(new URL(safeHref(s.url)).hostname.replace(/^www\./, ''))}</a>`)
    .join('');
}

async function loadConversations() {
  const list = await (await fetch('/api/conversations')).json();
  els.list.innerHTML = list
    .map((c) => `<li data-id="${esc(c.id)}" class="${c.id === conversationId ? 'active' : ''}">${esc(c.title)}<small>${esc(fmt(c.updatedAt))}</small></li>`)
    .join('');
  els.list.querySelectorAll('li').forEach((li) => (li.onclick = () => openConversation(li.dataset.id)));
}

async function openConversation(id) {
  conversationId = id;
  els.msgs.querySelectorAll('.msg').forEach((m) => m.remove());
  const msgs = await (await fetch(`/api/conversations/${id}/messages`)).json();
  if (!msgs.length) els.empty.hidden = false;
  msgs.forEach((m) => addMessage(m.role, m.content, m.createdAt, m.sources));
  loadConversations();
}

$('new-chat').onclick = () => {
  conversationId = null;
  els.msgs.querySelectorAll('.msg').forEach((m) => m.remove());
  els.empty.hidden = false;
  loadConversations();
  els.input.focus();
};

// ---- streaming ----
async function send(text) {
  busy = true;
  els.send.disabled = true;
  const now = simulatedNow();
  addMessage('user', text, now ? new Date(now).getTime() : Date.now());
  const div = addMessage('assistant', '', null);
  const body = div.querySelector('.body');
  const activity = div.querySelector('.activity');
  const searchRows = new Map();
  let answer = '';
  let frame = 0;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, message: text, timeZone, now }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        const e = JSON.parse(data);
        if (e.type === 'meta') {
          conversationId = e.conversationId;
          if (e.recall.mode !== 'none') {
            const row = document.createElement('div');
            row.textContent = e.recall.dates.length
              ? `Checked history for ${e.recall.dates.join(', ')}: ${e.recall.matched} message(s) found`
              : `Checked earlier conversations: ${e.recall.matched} message(s) found`;
            activity.appendChild(row);
          }
        } else if (e.type === 'search_start') {
          const row = document.createElement('div');
          row.className = 'running';
          row.textContent = `Searching: ${e.query}`;
          activity.appendChild(row);
          searchRows.set(e.id, row);
        } else if (e.type === 'search_end') {
          const row = searchRows.get(e.id);
          if (row) {
            row.className = '';
            row.textContent = e.error ? `Search failed: ${e.query} (${e.error})` : `Searched: ${e.query} (${e.results} results, ${e.cached ? 'cached' : `${e.ms} ms`})`;
          }
        } else if (e.type === 'fallback') {
          const row = document.createElement('div');
          row.textContent = `${e.from} is unavailable, switching to ${e.to}`;
          activity.appendChild(row);
        } else if (e.type === 'text') {
          answer += e.delta;
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            body.innerHTML = renderAnswer(answer);
            els.msgs.scrollTop = els.msgs.scrollHeight;
          });
        } else if (e.type === 'done') {
          cancelAnimationFrame(frame);
          body.innerHTML = renderAnswer(answer, e.sources);
          if (e.sources.length) renderSources(div, e.sources);
          const m = e.metrics;
          div.querySelector('.metrics').textContent =
            `${m.ttftMs != null ? `first token ${(m.ttftMs / 1000).toFixed(1)}s, ` : ''}total ${(m.totalMs / 1000).toFixed(1)}s, ${m.searches} search(es), ${m.model}`;
          div.querySelector('.stamp').textContent = fmt(now ? new Date(now).getTime() + m.totalMs : Date.now());
        } else if (e.type === 'error') {
          const p = document.createElement('div');
          p.className = 'error';
          p.textContent = e.message;
          div.appendChild(p);
        }
      }
    }
  } catch (err) {
    body.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    busy = false;
    els.send.disabled = false;
    loadConversations();
  }
}

els.form.onsubmit = (ev) => {
  ev.preventDefault();
  const text = els.input.value.trim();
  if (!text || busy) return;
  els.input.value = '';
  els.input.style.height = 'auto';
  send(text);
};
els.input.onkeydown = (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    els.form.requestSubmit();
  }
};
els.input.oninput = () => {
  els.input.style.height = 'auto';
  els.input.style.height = `${els.input.scrollHeight}px`;
};

(async () => {
  const h = await (await fetch('/api/health')).json();
  if (!h.ok) {
    els.banner.hidden = false;
    els.banner.textContent = `Setup needed: add ${h.missing.join(' and ')} to .env, then restart.`;
  }
  loadConversations();
})();
