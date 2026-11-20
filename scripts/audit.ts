import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { citedNumbers } from '../public/cite.js';

/**
 * Checks the stored data's invariants from the database alone, without trusting
 * the running server. Exits 1 on any failed check.
 *
 *   npx tsx scripts/audit.ts <dbPath>
 *
 * The live file is only read: it is copied with SQLite's online backup (safe while
 * the server writes, WAL included), and the FTS integrity check runs on the copy,
 * because that check is an INSERT command that a read-only handle cannot run.
 */

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: npx tsx scripts/audit.ts <dbPath>');
  process.exit(2);
}

// Defaults match src/config.ts; not imported so the audit never loads .env.
const CACHE_TTL_MS = 10 * 60 * 1000;
const TRACE_KEEP = Number(process.env.TRACE_KEEP || 1000);
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000; // the Dev clock can move forward, but not decades

const failures: string[] = [];
const info: string[] = [];
const fail = (check: string, detail: string) => failures.push(`${check}: ${detail}`);

const src = new Database(dbPath, { readonly: true, fileMustExist: true });
const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const copyPath = join(dir, 'copy.db');
await src.backup(copyPath);
src.close();
const db = new Database(copyPath);

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

// 1. Referential integrity: every message belongs to an existing conversation.
const orphans = count('SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id)');
if (orphans) fail('orphan messages', `${orphans} messages point at a missing conversation`);

// 2. No empty conversations: runTurn and import always add a message right after creating one,
//    and pruning deletes conversations it emptied.
const empty = db.prepare('SELECT id FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)').all() as { id: string }[];
if (empty.length) fail('empty conversations', `${empty.length} (${empty.slice(0, 3).map((e) => e.id).join(', ')})`);

// 3. Full-text index agrees with the messages table: one index doc per message, same ids,
//    and FTS5's own integrity check (rank=1 compares the index with the content table).
const msgCount = count('SELECT COUNT(*) AS n FROM messages');
const docCount = count('SELECT COUNT(*) AS n FROM messages_fts_docsize');
if (msgCount !== docCount) fail('fts row count', `${docCount} index docs for ${msgCount} messages`);
const missingDocs = count('SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM messages_fts_docsize d WHERE d.id = m.id)');
const staleDocs = count('SELECT COUNT(*) AS n FROM messages_fts_docsize d WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = d.id)');
if (missingDocs) fail('fts missing', `${missingDocs} messages are not indexed`);
if (staleDocs) fail('fts stale', `${staleDocs} index docs point at deleted messages`);
try {
  db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)").run();
} catch (err) {
  fail('fts integrity-check', err instanceof Error ? err.message : String(err));
}

// 4. Per-message checks.
type Row = { id: number; conversation_id: string; role: string; content: string; created_at: number; sources: string; status: string };
const rows = db.prepare('SELECT * FROM messages ORDER BY id').all() as Row[];
for (const m of rows) {
  if (m.role !== 'user' && m.role !== 'assistant') fail('role', `message ${m.id} has role "${m.role}"`);
  if (m.status !== 'answered' && m.status !== 'cancelled') fail('status', `message ${m.id} has status "${m.status}"`);
  if (m.role === 'user' && m.status !== 'answered') fail('status', `user message ${m.id} is "${m.status}"`);
  if (!m.content || !m.content.trim()) fail('content', `message ${m.id} is empty`);
  if (!Number.isInteger(m.created_at) || m.created_at < EARLIEST || m.created_at > LATEST) {
    fail('created_at', `message ${m.id} has created_at ${m.created_at} (${Number.isFinite(m.created_at) ? new Date(m.created_at).toISOString() : 'not a number'})`);
  }
  let sources: unknown;
  try {
    sources = JSON.parse(m.sources);
  } catch {
    fail('sources json', `message ${m.id} has unparseable sources`);
    continue;
  }
  if (!Array.isArray(sources)) {
    fail('sources json', `message ${m.id} sources is not an array`);
    continue;
  }
  if (m.role === 'user' && sources.length) fail('sources', `user message ${m.id} has sources`);
  const seen = new Set<number>();
  const cited = citedNumbers(m.content);
  for (const s of sources as { n?: unknown; url?: unknown }[]) {
    let ok = false;
    try {
      ok = ['http:', 'https:'].includes(new URL(String(s.url)).protocol);
    } catch {}
    if (!ok) fail('source url', `message ${m.id} has non-http(s) source url ${JSON.stringify(s.url)}`);
    if (typeof s.n !== 'number' || !Number.isInteger(s.n) || s.n < 1) {
      fail('source n', `message ${m.id} has source n=${JSON.stringify(s.n)}`);
      continue;
    }
    if (seen.has(s.n)) fail('source n', `message ${m.id} repeats source n=${s.n}`);
    seen.add(s.n);
    // Only sources the answer actually cites are stored (run.ts filters by citedNumbers).
    if (!cited.has(s.n)) fail('uncited source', `message ${m.id} stores source [${s.n}] that its text never cites`);
  }
}

// 5. Conversation timestamps: addMessage sets updated_at = MAX(updated_at, created_at),
//    so updated_at is never older than the conversation's newest message.
const behind = db
  .prepare(
    `SELECT c.id, c.updated_at AS u, MAX(m.created_at) AS newest FROM conversations c JOIN messages m ON m.conversation_id = c.id
     GROUP BY c.id HAVING c.updated_at < MAX(m.created_at)`,
  )
  .all() as { id: string; u: number; newest: number }[];
if (behind.length) fail('updated_at', `${behind.length} conversations have updated_at older than their newest message`);
const createdAfterUpdated = count('SELECT COUNT(*) AS n FROM conversations WHERE created_at > updated_at');
if (createdAfterUpdated) fail('conversation times', `${createdAfterUpdated} conversations have created_at > updated_at`);

// 6. Search cache: parseable rows; rows past the TTL are only informational (pruned hourly by the server).
const cacheRows = db.prepare('SELECT key, result, created_at FROM search_cache').all() as { key: string; result: string; created_at: number }[];
let staleCache = 0;
for (const r of cacheRows) {
  try {
    if (!Array.isArray(JSON.parse(r.result))) fail('cache json', `cache row ${r.key} is not an array`);
  } catch {
    fail('cache json', `cache row ${r.key} is unparseable`);
  }
  try {
    JSON.parse(r.key);
  } catch {
    fail('cache key', `cache key ${r.key} is not the JSON key format`);
  }
  if (!Number.isFinite(r.created_at)) fail('cache created_at', `cache row ${r.key} has created_at ${r.created_at}`);
  if (Date.now() - r.created_at > CACHE_TTL_MS) staleCache++;
}
info.push(`cache ${cacheRows.length} (${staleCache} past TTL, awaiting prune)`);

// 7. Traces: every row is a JSON object; above TRACE_KEEP is only informational (pruned hourly).
const traceRows = db.prepare('SELECT id, data FROM traces').all() as { id: number; data: string }[];
for (const t of traceRows) {
  try {
    const d = JSON.parse(t.data);
    if (!d || typeof d !== 'object' || Array.isArray(d)) fail('trace json', `trace ${t.id} is not an object`);
  } catch {
    fail('trace json', `trace ${t.id} is unparseable`);
  }
}
info.push(`traces ${traceRows.length}${traceRows.length > TRACE_KEEP ? ` (over TRACE_KEEP=${TRACE_KEEP}, awaiting prune)` : ''}`);

db.close();
rmSync(dir, { recursive: true, force: true });

const summary = `audit ${failures.length ? 'FAIL' : 'OK'}: ${msgCount} messages, ${new Set(rows.map((r) => r.conversation_id)).size} conversation ids in messages, ${empty.length} empty, ${docCount} fts docs, ${info.join(', ')}, ${failures.length} failures`;
for (const f of failures.slice(0, 50)) console.error(`  FAIL ${f}`);
if (failures.length > 50) console.error(`  ... and ${failures.length - 50} more`);
console.log(summary);
process.exit(failures.length ? 1 : 0);
