import { rmSync } from 'node:fs';
import { config, missingKeys } from '../src/config.js';
import { addMessage, createConversation, resetDb } from '../src/memory/store.js';
import { runTurn, type AgentEvent, type TurnMetrics } from '../src/agent/run.js';
import { demoHistory } from './demoHistory.js';

/**
 * npm run eval
 * Runs the challenge-style questions against the real model and search API on
 * a throwaway database seeded with demo history, then reports simple checks
 * and latency percentiles. Cheap rule checks, not an LLM judge: they catch the
 * failures that matter most here (wrong date, no search, no citations).
 */

interface Case {
  q: string;
  expect: { re: RegExp; why: string }[];
  mustSearch?: boolean;
  mustNotSearch?: boolean;
}

const CASES: Case[] = [
  {
    q: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    expect: [
      { re: /hubspot/i, why: 'recalls the shortlist' },
      { re: /pipedrive/i, why: 'recalls the shortlist' },
      { re: /\[\d+(\s*,\s*\d+)*\]/, why: 'cites sources' },
    ],
    mustSearch: true,
  },
  {
    q: 'What did I ask you on 3 November? Is your answer still correct today?',
    expect: [
      { re: /monitor|postgres/i, why: 'recalls what was asked on 3 Nov' },
      { re: /\[\d+(\s*,\s*\d+)*\]/, why: 'verifies with sources' },
    ],
    mustSearch: true,
  },
  {
    q: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    expect: [
      { re: /3 nov|november 3|3rd/i, why: 'resolves "last Tuesday" to the Postgres conversation date' },
      { re: /neon|supabase/i, why: 'recalls the providers' },
    ],
    mustSearch: true,
  },
  { q: 'What did I ask you on 1 November?', expect: [{ re: /(no|not|don't|didn't|nothing).{0,40}(record|conversation|messages|ask)/i, why: 'admits no history' }], mustNotSearch: true },
  { q: 'Thanks! That helps.', expect: [{ re: /./, why: 'replies' }], mustNotSearch: true },
  { q: 'Who is the current CEO of OpenAI?', expect: [{ re: /altman/i, why: 'correct fact' }], mustSearch: true },
];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function main() {
  const missing = missingKeys();
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')} in .env`);
    process.exit(1);
  }
  const tz = config.defaultTimezone;
  const now = new Date();
  const dbPath = 'data/eval.db';
  rmSync(dbPath, { force: true });
  resetDb(dbPath);
  for (const conv of demoHistory(now, tz)) {
    const c = createConversation(conv.title, conv.messages[0].at);
    conv.messages.forEach((m) => addMessage(c.id, m.role, m.content, m.at));
  }

  const metrics: TurnMetrics[] = [];
  let passed = 0;
  let total = 0;
  for (const c of CASES) {
    let answer = '';
    let m: TurnMetrics | null = null;
    await runTurn({
      text: c.q,
      now: new Date(),
      timeZone: tz,
      emit: (e: AgentEvent) => {
        if (e.type === 'text') answer += e.delta;
        if (e.type === 'done') m = e.metrics;
      },
    });
    const mm = m as TurnMetrics | null;
    if (mm) metrics.push(mm);
    const checks = [...c.expect.map((x) => ({ ok: x.re.test(answer), why: x.why }))];
    if (c.mustSearch) checks.push({ ok: (mm?.searches ?? 0) > 0, why: 'searched the web' });
    if (c.mustNotSearch) checks.push({ ok: (mm?.searches ?? 0) === 0, why: 'answered without searching' });
    console.log(`\nQ: ${c.q}\n${answer.slice(0, 600)}${answer.length > 600 ? ' ...' : ''}`);
    for (const k of checks) {
      total++;
      if (k.ok) passed++;
      console.log(`  ${k.ok ? 'PASS' : 'FAIL'}  ${k.why}`);
    }
    if (mm) console.log(`  first token ${mm.ttftMs} ms, total ${mm.totalMs} ms, ${mm.searches} search(es) (slowest ${mm.searchMs} ms), ${mm.steps} step(s)${mm.forcedSearch ? ', search forced' : ''}`);
  }

  const ttft = metrics.map((m) => m.ttftMs ?? m.totalMs);
  const tot = metrics.map((m) => m.totalMs);
  console.log(`\n${passed}/${total} checks passed`);
  console.log(`First token  p50 ${pct(ttft, 50)} ms  p95 ${pct(ttft, 95)} ms`);
  console.log(`Model        ${metrics[0]?.model}`);
  console.log(`Total        p50 ${pct(tot, 50)} ms  p95 ${pct(tot, 95)} ms`);
}

main();
