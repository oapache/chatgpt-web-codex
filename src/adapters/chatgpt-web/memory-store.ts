import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../../config";

/**
 * Durable per-thread record of everything a Codex turn carried, so context that auto-compaction
 * removes from the live window stays retrievable. The model reaches it through the
 * codex_memory_search / codex_memory_get MCP tools instead of holding it all at once.
 *
 * Retrieval is BM25 over SQLite FTS5: agent memory is dominated by exact tokens (paths, symbols,
 * error strings, commands) that keyword search resolves better than embeddings, and it needs no
 * model download or background service. `MemoryEmbedder` is the seam for semantic reranking.
 */
export interface ChatGptMemoryRecord {
  id: number;
  threadId: string;
  kind: string;
  ref: string;
  createdAt: number;
  text: string;
}

export interface ChatGptMemoryHit {
  id: number;
  kind: string;
  ref: string;
  createdAt: number;
  snippet: string;
  score: number;
}

/** Optional semantic reranker. Absent by default; FTS5 alone remains fully functional. */
export interface MemoryEmbedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

const MAX_RECORD_CHARS = 200_000;

function defaultDatabasePath(): string {
  return join(getConfigDir(), "memory", "thread-memory.db");
}

/**
 * FTS5 MATCH parses its input as a query expression, so raw conversation text would either throw a
 * syntax error or silently change meaning. Every term is quoted as a literal phrase instead.
 */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/[^\p{L}\p{N}_.:/\\-]+/u)
    .map(term => term.trim())
    .filter(term => term.length > 1)
    .slice(0, 32);
  if (terms.length === 0) return "";
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export class ChatGptMemoryStore {
  private readonly db: Database;

  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      text TEXT NOT NULL,
      UNIQUE (thread_id, ref)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS records_thread ON records (thread_id, id)");
    this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(text, content='records', content_rowid='id')");
    this.db.run(`CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
      INSERT INTO records_fts (rowid, text) VALUES (new.id, new.text);
    END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
      INSERT INTO records_fts (records_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
      INSERT INTO records_fts (records_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO records_fts (rowid, text) VALUES (new.id, new.text);
    END`);
  }

  /** Idempotent per (threadId, ref): re-recording the same turn record replaces its text. */
  record(threadId: string, kind: string, ref: string, text: string, createdAt = Date.now()): void {
    if (!threadId || !ref) throw new Error("memory record requires a thread id and ref");
    const bounded = text.length > MAX_RECORD_CHARS ? text.slice(0, MAX_RECORD_CHARS) : text;
    this.db.run(
      `INSERT INTO records (thread_id, kind, ref, created_at, text) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, ref) DO UPDATE SET text = excluded.text, kind = excluded.kind`,
      [threadId, kind, ref, createdAt, bounded],
    );
  }

  recordAll(threadId: string, entries: readonly { kind: string; ref: string; text: string }[]): number {
    const insert = this.db.transaction((items: readonly { kind: string; ref: string; text: string }[]) => {
      for (const item of items) this.record(threadId, item.kind, item.ref, item.text);
      return items.length;
    });
    return insert(entries);
  }

  search(threadId: string, query: string, limit = 8): ChatGptMemoryHit[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    return this.db.query(`
      SELECT r.id AS id, r.kind AS kind, r.ref AS ref, r.created_at AS createdAt,
             snippet(records_fts, 0, '<<', '>>', ' … ', 24) AS snippet,
             bm25(records_fts) AS score
      FROM records_fts
      JOIN records r ON r.id = records_fts.rowid
      WHERE records_fts MATCH ? AND r.thread_id = ?
      ORDER BY score
      LIMIT ?
    `).all(match, threadId, Math.max(1, Math.min(50, limit))) as ChatGptMemoryHit[];
  }

  get(threadId: string, id: number): ChatGptMemoryRecord | undefined {
    const row = this.db.query(
      "SELECT id, thread_id AS threadId, kind, ref, created_at AS createdAt, text FROM records WHERE id = ? AND thread_id = ?",
    ).get(id, threadId) as ChatGptMemoryRecord | null;
    return row ?? undefined;
  }

  count(threadId: string): number {
    const row = this.db.query("SELECT COUNT(*) AS total FROM records WHERE thread_id = ?")
      .get(threadId) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Split one compiled context envelope into per-message memory records. Each record keeps its
 * original index as the ref so re-recording a replayed turn updates in place instead of duplicating.
 */
export function contextPayloadMemoryEntries(
  contextPayload: string,
): { kind: string; ref: string; text: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextPayload);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const envelope = parsed as { system?: unknown; messages?: unknown };
  const entries: { kind: string; ref: string; text: string }[] = [];
  if (Array.isArray(envelope.system)) {
    envelope.system.forEach((content, index) => {
      if (typeof content !== "string" || !content.trim()) return;
      entries.push({ kind: "system", ref: `system:${index}`, text: content });
    });
  }
  if (Array.isArray(envelope.messages)) {
    envelope.messages.forEach((message, index) => {
      const text = JSON.stringify(message);
      if (!text) return;
      const role = message && typeof message === "object" && !Array.isArray(message)
        ? String((message as { role?: unknown }).role ?? "message")
        : "message";
      entries.push({ kind: role, ref: `message:${index}`, text });
    });
  }
  return entries;
}
