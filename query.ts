// Shared read query layer.
//
// One place that knows how to turn DB rows (snake_case) into the camelCase
// model from model.ts, and the parameterized SQL behind every read path.
// REST (server.ts), CLI (cli.ts), and the MCP memory server all call these —
// no inline SQL or row mapping should live in those entry points.
//
// All functions are read-only and synchronous (better-sqlite3).

import type Database from "better-sqlite3";
import type { Message, Session, Source } from "./model.js";

// --- Row shapes ---------------------------------------------------------------

export interface SessionRow {
  id: string;
  source: Source;
  native_id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  created_at: string | null;
  updated_at: string | null;
  source_path: string;
  source_status: "present" | "deleted";
  archived_at: string;
  meta: string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: Message["role"];
  content: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  timestamp: string | null;
  raw: string;
}

// --- Row → model mappers ------------------------------------------------------

export function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    source: r.source,
    nativeId: r.native_id,
    title: r.title,
    projectPath: r.project_path,
    model: r.model,
    messageCount: r.message_count,
    totalInputTokens: r.total_input_tokens,
    totalOutputTokens: r.total_output_tokens,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sourcePath: r.source_path,
    sourceStatus: r.source_status,
    archivedAt: r.archived_at,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {},
  };
}

export function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role,
    content: r.content ?? "",
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    timestamp: r.timestamp,
    raw: r.raw,
  };
}

// --- Shared shapes ------------------------------------------------------------

export interface Page<T> {
  items: T[];
  total: number;
}

export interface SearchHit {
  session: Pick<Session, "id" | "source" | "title" | "projectPath" | "updatedAt">;
  message: Pick<Message, "id" | "sessionId" | "seq" | "role" | "timestamp">;
  /** FTS5 snippet with `«` / `»` around matches. */
  snippet: string;
}

// --- Helpers ------------------------------------------------------------------

/** Parse + clamp an optional integer (query strings, CLI args) into [min,max]. */
export function clampInt(
  v: string | number | undefined,
  def: number,
  min: number,
  max: number
): number {
  const n =
    v === undefined ? def : typeof v === "number" ? v : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// --- Queries ------------------------------------------------------------------

export interface ListSessionsOptions {
  source?: string;
  /** "present" | "deleted" */
  status?: string;
  /** Substring match against title or project_path. */
  q?: string;
  limit: number;
  offset: number;
}

export function listSessions(
  db: Database.Database,
  opts: ListSessionsOptions
): Page<Session> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.source) {
    where.push("source = @source");
    params.source = opts.source;
  }
  if (opts.status) {
    where.push("source_status = @status");
    params.status = opts.status;
  }
  if (opts.q) {
    where.push("(title LIKE @q OR project_path LIKE @q)");
    params.q = `%${opts.q}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM sessions ${whereSql}`)
      .get(params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT * FROM sessions ${whereSql}
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: opts.limit, offset: opts.offset }) as SessionRow[];

  return { items: rows.map(rowToSession), total };
}

export function getSession(
  db: Database.Database,
  id: string
): Session | undefined {
  const row = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function sessionExists(db: Database.Database, id: string): boolean {
  return db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id) !== undefined;
}

export interface GetMessagesOptions {
  limit: number;
  offset: number;
}

export function getMessages(
  db: Database.Database,
  sessionId: string,
  opts: GetMessagesOptions
): Page<Message> {
  const total = (
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE session_id = ?
       ORDER BY seq ASC LIMIT ? OFFSET ?`
    )
    .all(sessionId, opts.limit, opts.offset) as MessageRow[];

  return { items: rows.map(rowToMessage), total };
}

export interface SearchOptions {
  limit: number;
  source?: string;
}

/** FTS5 full-text search over message content. Returns [] for an empty query. */
export function searchMessages(
  db: Database.Database,
  query: string,
  opts: SearchOptions
): SearchHit[] {
  const q = query.trim();
  if (!q) return [];

  const where: string[] = ["messages_fts MATCH @q"];
  const params: Record<string, unknown> = { q, limit: opts.limit };
  if (opts.source) {
    where.push("s.source = @source");
    params.source = opts.source;
  }

  const rows = db
    .prepare(
      `SELECT
          s.id            AS s_id,
          s.source        AS s_source,
          s.title         AS s_title,
          s.project_path  AS s_project_path,
          s.updated_at    AS s_updated_at,
          m.id            AS m_id,
          m.session_id    AS m_session_id,
          m.seq           AS m_seq,
          m.role          AS m_role,
          m.timestamp     AS m_timestamp,
          snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank
       LIMIT @limit`
    )
    .all(params) as Array<{
      s_id: string;
      s_source: Source;
      s_title: string | null;
      s_project_path: string | null;
      s_updated_at: string | null;
      m_id: string;
      m_session_id: string;
      m_seq: number;
      m_role: Message["role"];
      m_timestamp: string | null;
      snippet: string;
    }>;

  return rows.map((r) => ({
    session: {
      id: r.s_id,
      source: r.s_source,
      title: r.s_title,
      projectPath: r.s_project_path,
      updatedAt: r.s_updated_at,
    },
    message: {
      id: r.m_id,
      sessionId: r.m_session_id,
      seq: r.m_seq,
      role: r.m_role,
      timestamp: r.m_timestamp,
    },
    snippet: r.snippet,
  }));
}
