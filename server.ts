import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { dbPath, migrateLegacyDataHome } from "./paths.js";
import type { Message, Session } from "./model.js";
import {
  clampInt,
  getMessages,
  getSession,
  listSessions,
  searchMessages,
  sessionExists,
  type SearchHit,
} from "./query.js";

// Row shapes, mappers, and SQL now live in query.ts so REST, CLI, and the MCP
// server share one read path. This file only maps HTTP ⇆ those functions.

// Re-exported for the web client, which imports response types from "../../server.js".
export type { SearchHit } from "./query.js";

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

export interface SearchResponse {
  query: string;
  items: SearchHit[];
  limit: number;
}

// --- App ----------------------------------------------------------------------

export function createApp(db: Database.Database) {
  const app = new Hono()
    .use("*", cors())

    .get("/sessions", (c) => {
      const limit = clampInt(c.req.query("limit"), 50, 1, 500);
      const offset = clampInt(c.req.query("offset"), 0, 0, 1_000_000);
      const { items, total } = listSessions(db, {
        source: c.req.query("source"),
        status: c.req.query("status"), // 'present' | 'deleted'
        q: c.req.query("q"), // title/projectPath substring
        limit,
        offset,
      });
      const body: SessionListResponse = { items, total, limit, offset };
      return c.json(body);
    })

    .get("/sessions/:id", (c) => {
      const session = getSession(db, c.req.param("id"));
      if (!session) return c.json({ error: "not_found" }, 404);
      return c.json(session);
    })

    .get("/sessions/:id/messages", (c) => {
      const id = c.req.param("id");
      const limit = clampInt(c.req.query("limit"), 200, 1, 2000);
      const offset = clampInt(c.req.query("offset"), 0, 0, 10_000_000);

      if (!sessionExists(db, id)) return c.json({ error: "not_found" }, 404);

      const { items, total } = getMessages(db, id, { limit, offset });
      const body: MessageListResponse = {
        sessionId: id,
        items,
        total,
        limit,
        offset,
      };
      return c.json(body);
    })

    .get("/search", (c) => {
      const q = (c.req.query("q") ?? "").trim();
      const limit = clampInt(c.req.query("limit"), 20, 1, 200);
      const items = searchMessages(db, q, {
        limit,
        source: c.req.query("source"),
      });
      const body: SearchResponse = { query: q, limit, items };
      return c.json(body);
    });

  return app;
}

// Type exported for Hono RPC client: `hc<AppType>(baseUrl)` on the frontend.
export type AppType = ReturnType<typeof createApp>;

// --- Entry point --------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js");

if (isMain) {
  migrateLegacyDataHome();
  const db = openDb(dbPath());
  const app = createApp(db);
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, ({ port }) => {
    console.log(`open-agent-memory server listening on http://localhost:${port}`);
  });
}
