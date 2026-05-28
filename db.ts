import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Adapter } from "./adapters/adapter.js";

// --- Schema -------------------------------------------------------------------
// Archive-first: message.raw holds the verbatim source so we can re-derive
// everything if a format changes. source_path + source_status are the "pointer"
// back to the original, so we know whether the source still exists.

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  source              TEXT NOT NULL,
  native_id           TEXT NOT NULL,
  title               TEXT,
  project_path        TEXT,
  model               TEXT,
  message_count       INTEGER NOT NULL DEFAULT 0,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT,
  updated_at          TEXT,
  source_path         TEXT NOT NULL,
  source_status       TEXT NOT NULL DEFAULT 'present',
  archived_at         TEXT NOT NULL,
  meta                TEXT,
  UNIQUE(source, native_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source  ON sessions(source);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  timestamp     TEXT,
  raw           TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

-- Tracks where we last read each source file (append-only offset + stat).
CREATE TABLE IF NOT EXISTS sync_state (
  source_path    TEXT PRIMARY KEY,
  source         TEXT NOT NULL,
  byte_offset    INTEGER NOT NULL DEFAULT 0,
  mtime_ms       INTEGER,
  last_synced_at TEXT
);

-- Full-text search over message content, kept in sync via triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export function openDb(file: string): Database.Database {
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

// --- Ingest engine ------------------------------------------------------------

/**
 * Sync one adapter into the db. Returns counts. Incremental: only files that
 * changed since last sync are re-read, and append-only files are read from
 * their last byte offset. Sessions whose source file vanished are marked
 * 'deleted' but kept (the whole point of archiving).
 */
export async function sync(db: Database.Database, adapter: Adapter) {
  const files = await adapter.discover();
  const seenPaths = new Set(files.map((f) => f.path));

  const getState = db.prepare(
    "SELECT byte_offset, mtime_ms FROM sync_state WHERE source_path = ?"
  );
  const upsertState = db.prepare(`
    INSERT INTO sync_state (source_path, source, byte_offset, mtime_ms, last_synced_at)
    VALUES (@source_path, @source, @byte_offset, @mtime_ms, @now)
    ON CONFLICT(source_path) DO UPDATE SET
      byte_offset = @byte_offset, mtime_ms = @mtime_ms, last_synced_at = @now
  `);
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, source, native_id, title, project_path, model,
      created_at, updated_at, source_path, source_status, archived_at, meta)
    VALUES (@id, @source, @native_id, @title, @project_path, @model,
      @created_at, @updated_at, @source_path, 'present', @now, @meta)
    ON CONFLICT(id) DO UPDATE SET
      title        = COALESCE(sessions.title, @title),
      project_path = COALESCE(@project_path, sessions.project_path),
      model        = COALESCE(@model, sessions.model),
      updated_at   = @updated_at,
      source_path  = @source_path,
      source_status= 'present',
      meta         = @meta
  `);
  const countMsgs = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?"
  );
  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, seq, role, content, model,
      input_tokens, output_tokens, timestamp, raw)
    VALUES (@id, @session_id, @seq, @role, @content, @model,
      @input_tokens, @output_tokens, @timestamp, @raw)
  `);
  const recount = db.prepare(`
    UPDATE sessions SET
      message_count = (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id),
      total_input_tokens  = (SELECT COALESCE(SUM(input_tokens),0)  FROM messages WHERE session_id = sessions.id),
      total_output_tokens = (SELECT COALESCE(SUM(output_tokens),0) FROM messages WHERE session_id = sessions.id)
    WHERE id = ?
  `);

  let newSessions = 0;
  let newMessages = 0;

  for (const f of files) {
    const state = getState.get(f.path) as
      | { byte_offset: number; mtime_ms: number }
      | undefined;

    // Unchanged since last sync? Skip.
    if (state && state.mtime_ms === f.mtimeMs && state.byte_offset >= f.sizeBytes) {
      continue;
    }

    const fromByte = state?.byte_offset ?? 0;
    const { session, messages, newByteOffset } = await adapter.parseFile(
      f.path,
      fromByte
    );
    if (messages.length === 0 && !state) continue;

    const now = new Date().toISOString();
    const sessionId = sha1(`${session.source}:${session.nativeId}`);

    const tx = db.transaction(() => {
      const existed = countMsgs.get(sessionId) as { n: number };
      if (existed.n === 0) newSessions++;

      upsertSession.run({
        id: sessionId,
        source: session.source,
        native_id: session.nativeId,
        title: session.title,
        project_path: session.projectPath,
        model: session.model,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        source_path: session.sourcePath,
        meta: JSON.stringify(session.meta ?? {}),
        now,
      });

      let seq = existed.n; // append-only: continue numbering
      for (const m of messages) {
        const id = m.nativeUuid
          ? sha1(`${session.source}:${m.nativeUuid}`)
          : sha1(`${sessionId}:${seq}`);
        const res = insertMsg.run({
          id,
          session_id: sessionId,
          seq,
          role: m.role,
          content: m.content,
          model: m.model,
          input_tokens: m.inputTokens,
          output_tokens: m.outputTokens,
          timestamp: m.timestamp,
          raw: m.raw,
        });
        if (res.changes > 0) newMessages++;
        seq++;
      }
      recount.run(sessionId);

      upsertState.run({
        source_path: f.path,
        source: adapter.source,
        byte_offset: newByteOffset,
        mtime_ms: f.mtimeMs,
        now,
      });
    });
    tx();
  }

  // Mark sessions whose source file disappeared (kept, not deleted).
  const known = db
    .prepare("SELECT source_path FROM sync_state WHERE source = ?")
    .all(adapter.source) as { source_path: string }[];
  const markDeleted = db.prepare(
    "UPDATE sessions SET source_status = 'deleted' WHERE source_path = ? AND source = ?"
  );
  let markedDeleted = 0;
  for (const { source_path } of known) {
    if (!seenPaths.has(source_path)) {
      const stillThere = await fs
        .access(source_path)
        .then(() => true)
        .catch(() => false);
      if (!stillThere) {
        const r = markDeleted.run(source_path, adapter.source);
        markedDeleted += r.changes;
      }
    }
  }

  return { newSessions, newMessages, markedDeleted };
}
