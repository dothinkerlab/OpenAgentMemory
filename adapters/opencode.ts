import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import type {
  Adapter,
  DiscoveredFile,
  ParseResult,
  ParsedMessage,
  ParsedSession,
} from "./adapter.js";
import type { Role } from "../model.js";

/**
 * OpenCode stores all sessions in a single SQLite database at
 *   ~/.local/share/opencode/opencode.db
 *
 * Schema (relevant tables):
 *   session  – id, directory (cwd), title, model (JSON), time_created/updated (epoch ms),
 *              tokens_input/output
 *   message  – id, session_id, data (JSON: role, tokens, modelID, providerID, time, ...)
 *   part     – id, message_id, session_id, data (JSON: type + type-specific fields)
 *
 * Part types we care about:
 *   "text"       – {type, text}  ← user / assistant message content
 *   "reasoning"  – {type, text, time}  ← model chain-of-thought
 *   "tool"       – {type, tool, callID, state: {status, input, output, ...}}
 *   "step-start" – snapshot marker, no content worth indexing
 *
 * Because one file = all sessions, discover() returns one DiscoveredFile per
 * session using virtual paths `<db_path>::<session_id>`.  parseFile() splits
 * the path back apart, opens the DB read-only, and returns a single session.
 */

const DB_PATH = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db"
);

const PATH_SEP = "::";

// --- Raw shapes (intentionally loose) ----------------------------------------

interface SessionRow {
  id: string;
  directory: string;
  title: string;
  model: string | null; // JSON {"id":"...", "providerID":"..."}
  time_created: number; // epoch ms
  time_updated: number; // epoch ms
  tokens_input: number;
  tokens_output: number;
}

interface MessageRow {
  id: string;
  data: string; // JSON
}

interface MessageData {
  role?: string; // "user" | "assistant"
  modelID?: string;
  providerID?: string;
  time?: { created?: number; completed?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
}

interface PartRow {
  id: string;
  message_id: string;
  data: string; // JSON
}

interface PartData {
  type: string; // "text" | "reasoning" | "tool" | "step-start" | ...
  text?: string;
  // tool
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    title?: string;
  };
}

// --- Helpers ------------------------------------------------------------------

function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseModel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as { id?: string; providerID?: string };
    const parts = [m.providerID, m.id].filter(Boolean);
    return parts.length ? parts.join("/") : null;
  } catch {
    return raw;
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function openReadOnly(dbPath: string): Database.Database | null {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

// --- Adapter ------------------------------------------------------------------

export class OpenCodeAdapter implements Adapter {
  readonly source = "opencode" as const;

  async discover(): Promise<DiscoveredFile[]> {
    const db = openReadOnly(DB_PATH);
    if (!db) return [];

    let rows: SessionRow[];
    try {
      rows = db
        .prepare(
          `SELECT id, directory, title, model, time_created, time_updated,
                  tokens_input, tokens_output
           FROM session ORDER BY time_created`
        )
        .all() as SessionRow[];
    } catch {
      return [];
    } finally {
      db.close();
    }

    return rows.map((r) => ({
      // Virtual path: "db_path::session_id"
      path: `${DB_PATH}${PATH_SEP}${r.id}`,
      // Use time_updated as a synthetic "size": unchanged = already synced.
      sizeBytes: r.time_updated,
      mtimeMs: r.time_updated,
    }));
  }

  async parseFile(filePath: string, _fromByte?: number): Promise<ParseResult> {
    const sepIdx = filePath.lastIndexOf(PATH_SEP);
    const dbPath = filePath.slice(0, sepIdx);
    const sessionId = filePath.slice(sepIdx + PATH_SEP.length);

    // Fallback session in case of DB errors.
    const fallback: ParsedSession = {
      nativeId: sessionId,
      source: this.source,
      title: null,
      projectPath: null,
      model: null,
      createdAt: null,
      updatedAt: null,
      sourcePath: filePath,
      meta: {},
    };

    const db = openReadOnly(dbPath);
    if (!db) return { session: fallback, messages: [], newByteOffset: 0 };

    try {
      const sr = db
        .prepare(
          `SELECT id, directory, title, model, time_created, time_updated,
                  tokens_input, tokens_output
           FROM session WHERE id = ?`
        )
        .get(sessionId) as SessionRow | undefined;

      if (!sr) return { session: fallback, messages: [], newByteOffset: 0 };

      const session: ParsedSession = {
        nativeId: sr.id,
        source: this.source,
        title: sr.title || null,
        projectPath: sr.directory || null,
        model: parseModel(sr.model),
        createdAt: epochMsToIso(sr.time_created),
        updatedAt: epochMsToIso(sr.time_updated),
        sourcePath: filePath,
        meta: {},
      };

      // Fetch all messages for this session (ordered by creation time).
      const msgRows = db
        .prepare(
          `SELECT id, data FROM message
           WHERE session_id = ?
           ORDER BY time_created, id`
        )
        .all(sessionId) as MessageRow[];

      // Fetch all parts for this session in one query, keyed by message_id.
      const partRows = db
        .prepare(
          `SELECT id, message_id, data FROM part
           WHERE session_id = ?
           ORDER BY time_created, id`
        )
        .all(sessionId) as PartRow[];

      // Group parts by message.
      const partsByMsg = new Map<string, PartRow[]>();
      for (const p of partRows) {
        let arr = partsByMsg.get(p.message_id);
        if (!arr) {
          arr = [];
          partsByMsg.set(p.message_id, arr);
        }
        arr.push(p);
      }

      const messages: ParsedMessage[] = [];

      for (const msgRow of msgRows) {
        let msgData: MessageData = {};
        try {
          msgData = JSON.parse(msgRow.data) as MessageData;
        } catch {
          // keep empty
        }

        const msgRole = msgData.role ?? "user";
        const msgModel =
          msgData.modelID && msgData.providerID
            ? `${msgData.providerID}/${msgData.modelID}`
            : (msgData.modelID ?? null);
        const msgTs = msgData.time?.created
          ? epochMsToIso(msgData.time.created)
          : null;
        const inputTokens = msgData.tokens?.input ?? null;
        const outputTokens = msgData.tokens?.output ?? null;

        const parts = partsByMsg.get(msgRow.id) ?? [];
        let tokensEmitted = false;

        for (const partRow of parts) {
          let pd: PartData;
          try {
            pd = JSON.parse(partRow.data) as PartData;
          } catch {
            continue;
          }

          let role: Role;
          let content: string;

          switch (pd.type) {
            case "text": {
              const text = (pd.text ?? "").trim();
              if (!text) continue;
              role = msgRole === "assistant" ? "assistant" : "user";
              content = text;
              break;
            }
            case "reasoning": {
              const text = (pd.text ?? "").trim();
              if (!text) continue;
              role = "assistant";
              content = `[reasoning] ${text}`;
              break;
            }
            case "tool": {
              const toolName = pd.tool ?? "?";
              const title = pd.state?.title ?? "";
              const inputStr = safeJson(pd.state?.input);
              const outputStr = safeJson(pd.state?.output);
              role = "tool";
              content = [
                `[tool: ${toolName}]${title ? ` ${truncate(title, 60)}` : ""}`,
                inputStr && inputStr !== "undefined" ? `input: ${inputStr}` : "",
                outputStr && outputStr !== "undefined" && outputStr !== "null"
                  ? `output: ${outputStr}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n");
              break;
            }
            case "step-start":
              continue;
            default:
              // Unknown future part type — preserve as raw JSON.
              content = safeJson(pd);
              role = msgRole === "assistant" ? "assistant" : "user";
          }

          // Emit token counts only on the first content-bearing part per message.
          const emitTokens = !tokensEmitted && (inputTokens || outputTokens);
          if (emitTokens) tokensEmitted = true;

          messages.push({
            nativeUuid: partRow.id,
            role,
            content,
            model: msgModel,
            inputTokens: emitTokens ? inputTokens : null,
            outputTokens: emitTokens ? outputTokens : null,
            timestamp: msgTs,
            raw: partRow.data,
          });
        }
      }

      // newByteOffset = time_updated so the sync engine knows "fully processed".
      return { session, messages, newByteOffset: sr.time_updated };
    } finally {
      db.close();
    }
  }
}
