import { config } from '../config.js';
import { getDb } from './store.js';

/**
 * Keeps the database from growing without bound.
 * - search_cache: rows past the cache TTL are never read again, so they are deleted.
 * - traces: debugging data only; keep the newest `traceKeep` rows.
 * - messages: these ARE the memory, so they are kept forever unless
 *   MESSAGE_RETENTION_DAYS is set. Deleting them makes "what did I ask on X?"
 *   unanswerable for older dates; that is the trade-off of turning it on.
 */

export interface PruneResult {
  cache: number;
  traces: number;
  messages: number;
  conversations: number;
}

export interface PruneOptions {
  now?: number;
  cacheTtlMs?: number;
  traceKeep?: number;
  /** 0 or less = keep every message. */
  messageRetentionDays?: number;
}

/**
 * messages_fts is an external-content FTS5 table. The store only has an INSERT
 * trigger; deleting a message without this trigger would leave a stale index
 * entry that BM25 search would still return (pointing at a missing row).
 */
function ensureDeleteTrigger() {
  getDb().exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);
}

export function pruneDb(opts: PruneOptions = {}): PruneResult {
  const now = opts.now ?? Date.now();
  const cacheTtlMs = opts.cacheTtlMs ?? config.searchCacheTtlMs;
  const traceKeep = opts.traceKeep ?? config.traceKeep;
  const retentionDays = opts.messageRetentionDays ?? config.messageRetentionDays;
  const db = getDb();
  ensureDeleteTrigger();

  return db.transaction((): PruneResult => {
    const cache = db.prepare('DELETE FROM search_cache WHERE created_at < ?').run(now - cacheTtlMs).changes;
    const traces = db
      .prepare('DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY id DESC LIMIT ?)')
      .run(Math.max(0, traceKeep)).changes;

    let messages = 0;
    let conversations = 0;
    if (retentionDays > 0) {
      const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
      messages = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff).changes;
      // A conversation with no messages left would show up empty in the sidebar.
      conversations = db
        .prepare('DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)')
        .run().changes;
    }
    return { cache, traces, messages, conversations };
  })();
}

/**
 * Prune once now, then on an interval. The timer is unref'd so it never keeps
 * the process alive; call the returned function to stop it.
 */
export function startPruning(intervalMs = config.pruneIntervalMs): () => void {
  const run = () => {
    try {
      const r = pruneDb();
      if (r.cache || r.traces || r.messages) {
        console.log(`[prune] removed ${r.cache} cache rows, ${r.traces} traces, ${r.messages} messages, ${r.conversations} conversations`);
      }
    } catch (err) {
      console.error('[prune] failed:', err instanceof Error ? err.message : err);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
