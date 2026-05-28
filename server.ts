import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "./db.js";
import type { Message, Session, Source } from "./model.js";

// --- Row → model mappers ------------------------------------------------------
// DB columns are snake_case; the shared model is camelCase. Mapping lives here
// so the rest of the app (CLI, future adapters, frontend) only ever sees model.ts.

interface SessionRow {
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

interface MessageRow {
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

function rowToSession(r: SessionRow): Session {
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

function rowToMessage(r: MessageRow): Message {
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

// --- Response shapes ----------------------------------------------------------

export interface SessionListResponse {
  items: Session[];
  total: number;
  limit: number;
  offset: number;
}

export interface MessageListResponse {
  sessionId: string;
  items: Message[];
  total: number;
  limit: number;
  offset: number;
}

export interface SearchHit {
  session: Pick<Session, "id" | "source" | "title" | "projectPath" | "updatedAt">;
  message: Pick<Message, "id" | "sessionId" | "seq" | "role" | "timestamp">;
  /** FTS5 snippet with `«` / `»` around matches. */
  snippet: string;
}

export interface SearchResponse {
  query: string;
  items: SearchHit[];
  limit: number;
}

// --- App ----------------------------------------------------------------------

function clampInt(v: string | undefined, def: number, min: number, max: number) {
  const n = v === undefined ? def : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export function createApp(db: Database.Database) {
  const app = new Hono()
    .use("*", cors())

    .get("/sessions", (c) => {
      const source = c.req.query("source");
      const status = c.req.query("status"); // 'present' | 'deleted'
      const q = c.req.query("q"); // title/projectPath substring
      const limit = clampInt(c.req.query("limit"), 50, 1, 500);
      const offset = clampInt(c.req.query("offset"), 0, 0, 1_000_000);

      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (source) {
        where.push("source = @source");
        params.source = source;
      }
      if (status) {
        where.push("source_status = @status");
        params.status = status;
      }
      if (q) {
        where.push("(title LIKE @q OR project_path LIKE @q)");
        params.q = `%${q}%`;
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
        .all({ ...params, limit, offset }) as SessionRow[];

      const body: SessionListResponse = {
        items: rows.map(rowToSession),
        total,
        limit,
        offset,
      };
      return c.json(body);
    })

    .get("/sessions/:id", (c) => {
      const id = c.req.param("id");
      const row = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(id) as SessionRow | undefined;
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(rowToSession(row));
    })

    .get("/sessions/:id/messages", (c) => {
      const id = c.req.param("id");
      const limit = clampInt(c.req.query("limit"), 200, 1, 2000);
      const offset = clampInt(c.req.query("offset"), 0, 0, 10_000_000);

      const session = db
        .prepare("SELECT 1 FROM sessions WHERE id = ?")
        .get(id);
      if (!session) return c.json({ error: "not_found" }, 404);

      const total = (
        db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
          .get(id) as { n: number }
      ).n;

      const rows = db
        .prepare(
          `SELECT * FROM messages WHERE session_id = ?
           ORDER BY seq ASC LIMIT ? OFFSET ?`
        )
        .all(id, limit, offset) as MessageRow[];

      const body: MessageListResponse = {
        sessionId: id,
        items: rows.map(rowToMessage),
        total,
        limit,
        offset,
      };
      return c.json(body);
    })

    .get("/search", (c) => {
      const q = (c.req.query("q") ?? "").trim();
      const limit = clampInt(c.req.query("limit"), 20, 1, 200);
      const source = c.req.query("source");

      if (!q) {
        const empty: SearchResponse = { query: "", items: [], limit };
        return c.json(empty);
      }

      const where: string[] = ["messages_fts MATCH @q"];
      const params: Record<string, unknown> = { q, limit };
      if (source) {
        where.push("s.source = @source");
        params.source = source;
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

      const body: SearchResponse = {
        query: q,
        limit,
        items: rows.map((r) => ({
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
        })),
      };
      return c.json(body);
    });

  return app;
}

// Type exported for Hono RPC client: `hc<AppType>(baseUrl)` on the frontend.
export type AppType = ReturnType<typeof createApp>;

// --- Entry point --------------------------------------------------------------

const DB_PATH = path.join(os.homedir(), ".ai-sessions", "archive.db");

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");

if (isMain) {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  const app = createApp(db);
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, ({ port }) => {
    console.log(`ai-sessions server listening on http://localhost:${port}`);
  });
}
