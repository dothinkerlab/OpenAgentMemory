import { promises as fs } from "node:fs";
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
 * Codex stores sessions as JSONL files under two locations:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (active)
 *   ~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl    (archived)
 *
 * Each file contains a mix of record types:
 *   session_meta   – session id, cwd, model provider, cli version
 *   event_msg      – user_message (user prompt), agent_message (commentary/final_answer),
 *                    task_started, token_count, turn_aborted
 *   response_item  – message (role=user/developer/assistant), function_call,
 *                    function_call_output, reasoning
 *   turn_context   – per-turn metadata (cwd, date, policy)
 */

const ROOTS = [
  path.join(os.homedir(), ".codex", "sessions"),
  path.join(os.homedir(), ".codex", "archived_sessions"),
];

// --- Raw shapes (intentionally loose) ----------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
}

interface RawLine {
  timestamp?: string;
  type?: string; // "session_meta" | "event_msg" | "response_item" | "turn_context"
  payload?: {
    // session_meta
    id?: string;
    cwd?: string;
    cli_version?: string;
    originator?: string;
    model_provider?: string;
    model?: string;

    // event_msg subtypes
    type?: string; // "user_message" | "agent_message" | "task_started" | "token_count" | ...
    message?: string; // user_message / agent_message text
    phase?: string; // "commentary" | "final_answer"
    images?: unknown[];

    // response_item subtypes
    role?: string; // "user" | "developer" | "assistant"
    content?: ContentBlock[];
    name?: string; // function_call tool name
    arguments?: string; // function_call args JSON string
    call_id?: string;
    output?: unknown; // function_call_output (may be non-string in some versions)

    // reasoning
    summary?: unknown[];
    encrypted_content?: string;
  };
}

// --- Helpers ------------------------------------------------------------------

async function walkJsonl(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonl(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function flattenContent(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((b) => b.text ?? "")
    .join("\n\n")
    .trim();
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

/** Return true if a user-role response_item message looks like a system injection
 * (environment context, permissions, turn_aborted, etc.) rather than a real user turn. */
function isSystemInjection(text: string): boolean {
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<permissions") ||
    text.startsWith("<turn_aborted>") ||
    text.startsWith("<turn_context>")
  );
}

// --- Adapter ------------------------------------------------------------------

export class CodexAdapter implements Adapter {
  readonly source = "codex" as const;

  async discover(): Promise<DiscoveredFile[]> {
    const out: DiscoveredFile[] = [];
    for (const root of ROOTS) {
      for (const p of await walkJsonl(root)) {
        const st = await fs.stat(p);
        out.push({ path: p, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return out;
  }

  async parseFile(filePath: string, fromByte = 0): Promise<ParseResult> {
    const buf = await fs.readFile(filePath);
    const start = fromByte > 0 && fromByte <= buf.length ? fromByte : 0;
    const slice = buf.subarray(start).toString("utf8");

    const messages: ParsedMessage[] = [];
    let nativeId = path.basename(filePath, ".jsonl");
    let projectPath: string | null = null;
    let model: string | null = null;
    let title: string | null = null;
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    const meta: Record<string, unknown> = {};

    for (const rawLine of slice.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      let line: RawLine;
      try {
        line = JSON.parse(trimmed) as RawLine;
      } catch {
        continue;
      }

      const ts = line.timestamp ?? null;
      const p = line.payload;
      if (!p) continue;

      if (ts) {
        firstTs ??= ts;
        lastTs = ts;
      }

      switch (line.type) {
        case "session_meta": {
          if (p.id) nativeId = p.id;
          if (p.cwd) projectPath = p.cwd;
          if (p.model_provider) model = p.model ?? p.model_provider;
          if (p.cli_version) meta.cliVersion = p.cli_version;
          if (p.originator) meta.originator = p.originator;
          break;
        }

        case "event_msg": {
          switch (p.type) {
            case "user_message": {
              const text = (p.message ?? "").trim();
              if (!text) break;
              if (!title) title = truncate(text);
              messages.push({
                nativeUuid: null,
                role: "user",
                content: text,
                model: null,
                inputTokens: null,
                outputTokens: null,
                timestamp: ts,
                raw: trimmed,
              });
              break;
            }
            case "agent_message": {
              const text = (p.message ?? "").trim();
              if (!text) break;
              const phase = p.phase ?? "commentary";
              const content =
                phase === "final_answer"
                  ? text
                  : `[commentary] ${text}`;
              messages.push({
                nativeUuid: null,
                role: "assistant",
                content,
                model: null,
                inputTokens: null,
                outputTokens: null,
                timestamp: ts,
                raw: trimmed,
              });
              break;
            }
            // task_started, token_count, turn_aborted — no searchable content
            default:
              break;
          }
          break;
        }

        case "response_item": {
          switch (p.type) {
            case "message": {
              const role = p.role ?? "";
              // developer = system prompt injection; skip it (too noisy for search)
              if (role === "developer") break;
              const text = flattenContent(p.content);
              if (!text || isSystemInjection(text)) break;
              const mappedRole: Role =
                role === "assistant" ? "assistant" : "user";
              messages.push({
                nativeUuid: null,
                role: mappedRole,
                content: text,
                model: null,
                inputTokens: null,
                outputTokens: null,
                timestamp: ts,
                raw: trimmed,
              });
              break;
            }
            case "function_call": {
              let args = "";
              try {
                args = p.arguments
                  ? safeJson(JSON.parse(p.arguments))
                  : "";
              } catch {
                args = p.arguments ?? "";
              }
              messages.push({
                nativeUuid: null,
                role: "tool",
                content: `[tool: ${p.name ?? "?"}] ${args}`,
                model: null,
                inputTokens: null,
                outputTokens: null,
                timestamp: ts,
                raw: trimmed,
              });
              break;
            }
            case "function_call_output": {
              const out = safeJson(p.output).trim();
              if (!out || out === '""' || out === "null") break;
              messages.push({
                nativeUuid: null,
                role: "tool",
                content: `[tool_result] ${out}`,
                model: null,
                inputTokens: null,
                outputTokens: null,
                timestamp: ts,
                raw: trimmed,
              });
              break;
            }
            // reasoning: encrypted_content only — nothing searchable
            default:
              break;
          }
          break;
        }

        // turn_context: metadata only
        default:
          break;
      }
    }

    const session: ParsedSession = {
      nativeId,
      source: this.source,
      title,
      projectPath,
      model,
      createdAt: firstTs,
      updatedAt: lastTs,
      sourcePath: filePath,
      meta,
    };

    return { session, messages, newByteOffset: buf.length };
  }
}
