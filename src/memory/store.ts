import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * One SQLite file holds everything: conversations, every message with its
 * timestamp, a full-text index over messages, the search cache and traces.
 * SQLite is enough for a single-user local agent, needs no server, and FTS5
 * gives BM25 keyword ranking for free.
 */

export type Role = 'user' | 'assistant';

export interface Source {
  title: string;
  url: string;
  published?: string;
  n?: number; // the citation number used in the answer text
}

export interface StoredMessage {
  id: number;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: number;
  sources: Source[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

let db: Database.Database | null = null;

export function getDb(path = config.dbPath): Database.Database {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, content='messages', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS search_cache (
      key TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

/** Test helper: point the store at a fresh database. */
export function resetDb(path = ':memory:') {
  db?.close();
  db = null;
  getDb(path);
}

type Row = { id: number; conversation_id: string; role: Role; content: string; created_at: number; sources: string };
const toMessage = (r: Row): StoredMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
  sources: JSON.parse(r.sources),
});

export function createConversation(title: string, now: number, id: string = randomUUID()): Conversation {
  getDb().prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now);
  return { id, title, createdAt: now, updatedAt: now };
}

export function getConversation(id: string): Conversation | null {
  const r = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    | { id: string; title: string; created_at: number; updated_at: number }
    | undefined;
  return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}

export function listConversations(): Conversation[] {
  return (getDb().prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100').all() as any[]).map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function addMessage(conversationId: string, role: Role, content: string, createdAt: number, sources: Source[] = []): StoredMessage {
  const d = getDb();
  const info = d
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at, sources) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, role, content, createdAt, JSON.stringify(sources));
  d.prepare('UPDATE conversations SET updated_at = MAX(updated_at, ?) WHERE id = ?').run(createdAt, conversationId);
  return { id: Number(info.lastInsertRowid), conversationId, role, content, createdAt, sources };
}

export function getMessages(conversationId: string, limit = 1000): StoredMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at ASC, id ASC')
    .all(conversationId, limit) as Row[];
  return rows.map(toMessage);
}

export function messagesInRange(start: number, end: number, excludeIds: number[] = []): StoredMessage[] {
  const rows = getDb().prepare('SELECT * FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC, id ASC').all(start, end) as Row[];
  const skip = new Set(excludeIds);
  return rows.map(toMessage).filter((m) => !skip.has(m.id));
}

/** BM25 keyword search, optionally limited to a time range. Lower score = better match. */
export function searchMessages(ftsQuery: string, opts: { start?: number; end?: number; limit?: number } = {}): (StoredMessage & { score: number })[] {
  if (!ftsQuery) return [];
  const rows = getDb()
    .prepare(
      `SELECT m.*, bm25(messages_fts) AS score
       FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
       ORDER BY score LIMIT ?`,
    )
    .all(ftsQuery, opts.start ?? 0, opts.end ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 20) as (Row & { score: number })[];
  return rows.map((r) => ({ ...toMessage(r), score: r.score }));
}

/** The message just before/after another one in the same conversation (to pair a question with its answer). */
export function neighbour(m: StoredMessage, direction: 'prev' | 'next'): StoredMessage | null {
  const sql =
    direction === 'next'
      ? 'SELECT * FROM messages WHERE conversation_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT 1'
      : 'SELECT * FROM messages WHERE conversation_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 1';
  const r = getDb().prepare(sql).get(m.conversationId, m.createdAt, m.createdAt, m.id) as Row | undefined;
  return r ? toMessage(r) : null;
}

export function lastMessageBefore(at: number): StoredMessage | null {
  const r = getDb().prepare('SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT 1').get(at) as Row | undefined;
  return r ? toMessage(r) : null;
}

export function historyBounds(): { first: number | null; count: number } {
  const r = getDb().prepare('SELECT MIN(created_at) AS first, COUNT(*) AS count FROM messages').get() as { first: number | null; count: number };
  return r;
}

export function cacheGet(key: string, ttlMs: number, now: number): unknown | null {
  const r = getDb().prepare('SELECT result, created_at FROM search_cache WHERE key = ?').get(key) as { result: string; created_at: number } | undefined;
  if (!r || now - r.created_at > ttlMs) return null;
  return JSON.parse(r.result);
}

export function cacheSet(key: string, value: unknown, now: number) {
  getDb().prepare('INSERT OR REPLACE INTO search_cache (key, result, created_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), now);
}

export function saveTrace(conversationId: string, createdAt: number, data: unknown) {
  getDb().prepare('INSERT INTO traces (conversation_id, created_at, data) VALUES (?, ?, ?)').run(conversationId, createdAt, JSON.stringify(data));
}

export function recentTraces(limit = 50): unknown[] {
  return (getDb().prepare('SELECT data FROM traces ORDER BY id DESC LIMIT ?').all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
}
