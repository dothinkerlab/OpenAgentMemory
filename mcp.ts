#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { openDb } from "./db.js";
import type { Message, Session } from "./model.js";
import { dbPath, migrateLegacyDataHome } from "./paths.js";
import {
  clampInt,
  getMessages,
  getSession,
  listSessions,
  searchMessages,
  sessionExists,
  type SearchHit,
} from "./query.js";

const SOURCES = ["claude-code", "codex", "gemini", "opencode", "trae"] as const;
const STATUSES = ["present", "deleted"] as const;

type PublicSession = Omit<Session, "sourcePath">;
type PublicMessage = Omit<Message, "raw"> & { truncated: boolean };

const server = new McpServer({
  name: "open-agent-memory",
  version: "0.1.0",
});

migrateLegacyDataHome();
const db = openDb(dbPath());

function publicSession(session: Session): PublicSession {
  const { sourcePath, ...safe } = session;
  void sourcePath;
  return safe;
}

function truncateText(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}\n[truncated]`, truncated: true };
}

function publicMessage(message: Message, maxContentChars: number): PublicMessage {
  const { raw, content, ...safe } = message;
  void raw;
  const truncated = truncateText(content, maxContentChars);
  return { ...safe, content: truncated.text, truncated: truncated.truncated };
}

function ok(summary: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `${summary}\n\n${JSON.stringify(structuredContent, null, 2)}`,
      },
    ],
    structuredContent,
  };
}

function fail(message: string, details?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message, ...(details ?? {}) },
  };
}

function safeCall(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("memory query failed", { message });
  }
}

function publicHit(hit: SearchHit): SearchHit {
  return hit;
}

server.registerTool(
  "search_memory",
  {
    title: "Search archived AI session memory",
    description:
      "Full-text search across archived AI coding session messages. Read-only; returns snippets and message/session identifiers, not raw source records.",
    inputSchema: {
      query: z.string().trim().min(1).describe("FTS5 search query."),
      source: z.enum(SOURCES).optional().describe("Optional source adapter filter."),
      limit: z.number().int().optional().describe("Maximum hits to return; clamped to 1..100."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  ({ query, source, limit }) =>
    safeCall(() => {
      const safeLimit = clampInt(limit, 20, 1, 100);
      const items = searchMessages(db, query, { limit: safeLimit, source });
      return ok(`Found ${items.length} hit(s).`, {
        query,
        source: source ?? null,
        limit: safeLimit,
        items: items.map(publicHit),
      });
    })
);

server.registerTool(
  "list_sessions",
  {
    title: "List archived sessions",
    description:
      "List archived AI coding sessions with optional source, status, and title/project filters. Read-only and paginated.",
    inputSchema: {
      source: z.enum(SOURCES).optional().describe("Optional source adapter filter."),
      status: z.enum(STATUSES).optional().describe("Optional source status filter."),
      q: z.string().trim().optional().describe("Optional title/project substring filter."),
      limit: z.number().int().optional().describe("Maximum sessions to return; clamped to 1..100."),
      offset: z.number().int().optional().describe("Pagination offset; clamped to >= 0."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  ({ source, status, q, limit, offset }) =>
    safeCall(() => {
      const safeLimit = clampInt(limit, 50, 1, 100);
      const safeOffset = clampInt(offset, 0, 0, 1_000_000);
      const page = listSessions(db, {
        source,
        status,
        q,
        limit: safeLimit,
        offset: safeOffset,
      });
      return ok(`Returned ${page.items.length} session(s).`, {
        items: page.items.map(publicSession),
        total: page.total,
        limit: safeLimit,
        offset: safeOffset,
      });
    })
);

server.registerTool(
  "get_session",
  {
    title: "Get one archived session",
    description:
      "Fetch one archived AI coding session by stable session id. Read-only; omits the local source file path.",
    inputSchema: {
      id: z.string().trim().min(1).describe("Stable archived session id."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  ({ id }) =>
    safeCall(() => {
      const session = getSession(db, id);
      if (!session) return fail("session not found", { id });
      return ok("Returned session.", { session: publicSession(session) });
    })
);

server.registerTool(
  "get_messages",
  {
    title: "Get archived session messages",
    description:
      "Fetch messages for one archived session. Read-only; omits raw source records and bounds per-message content length.",
    inputSchema: {
      sessionId: z.string().trim().min(1).describe("Stable archived session id."),
      limit: z.number().int().optional().describe("Maximum messages to return; clamped to 1..500."),
      offset: z.number().int().optional().describe("Pagination offset; clamped to >= 0."),
      maxContentChars: z
        .number()
        .int()
        .optional()
        .describe("Maximum characters per message content; clamped to 500..20000."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  ({ sessionId, limit, offset, maxContentChars }) =>
    safeCall(() => {
      if (!sessionExists(db, sessionId)) return fail("session not found", { sessionId });
      const safeLimit = clampInt(limit, 200, 1, 500);
      const safeOffset = clampInt(offset, 0, 0, 10_000_000);
      const safeMaxContentChars = clampInt(maxContentChars, 8_000, 500, 20_000);
      const page = getMessages(db, sessionId, {
        limit: safeLimit,
        offset: safeOffset,
      });
      return ok(`Returned ${page.items.length} message(s).`, {
        sessionId,
        items: page.items.map((message) => publicMessage(message, safeMaxContentChars)),
        total: page.total,
        limit: safeLimit,
        offset: safeOffset,
        maxContentChars: safeMaxContentChars,
      });
    })
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("open-agent-memory MCP server listening on stdio");
}

main().catch((error) => {
  console.error("open-agent-memory MCP server failed:", error);
  process.exit(1);
});
