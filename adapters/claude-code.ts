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
 * Claude Code stores each session as a JSONL file under
 *   ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * (some versions nest under .../<encoded-cwd>/sessions/), one JSON event per
 * line: user turns, assistant turns, tool results, summaries, system events.
 *
 * The directory name encodes the cwd lossily (every non-alphanumeric char -> '-'),
 * so we DON'T decode it; we read the reliable `cwd` field from inside each line.
 */
const ROOT = path.join(os.homedir(), ".claude", "projects");

// --- Shapes we read from the JSONL (intentionally loose; format evolves) -----

interface ContentBlock {
  type: string; // "text" | "thinking" | "tool_use" | "tool_result" | ...
  text?: string;
  thinking?: string;
  name?: string; // tool_use
  input?: unknown; // tool_use
  content?: unknown; // tool_result: string | block[]
}

interface RawLine {
  type?: string; // "user" | "assistant" | "system" | "summary" | ...
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  summary?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

// --- Helpers ------------------------------------------------------------------

async function walkJsonl(dir: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // tool not installed / dir missing — not an error
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonl(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Map a line's type/role to our normalized role. */
function roleOf(line: RawLine): Role {
  const t = line.type;
  const r = line.message?.role;
  if (t === "user" || r === "user") return "user";
  if (t === "assistant" || r === "assistant") return "assistant";
  // tool results arrive as user-typed lines carrying tool_result blocks; we
  // tag them separately below, so anything left is treated as system/meta.
  return "system";
}

/** Flatten content (string or blocks) into searchable plain text. */
function flatten(content: string | ContentBlock[] | undefined): {
  text: string;
  hasToolResult: boolean;
} {
  if (content == null) return { text: "", hasToolResult: false };
  if (typeof content === "string") return { text: content, hasToolResult: false };

  let hasToolResult = false;
  const parts: string[] = [];
  for (const b of content) {
    switch (b.type) {
      case "text":
        if (b.text) parts.push(b.text);
        break;
      case "thinking":
        if (b.thinking) parts.push(`[thinking] ${b.thinking}`);
        break;
      case "tool_use":
        parts.push(`[tool: ${b.name ?? "?"}] ${safeJson(b.input)}`);
        break;
      case "tool_result": {
        hasToolResult = true;
        const c = b.content;
        if (typeof c === "string") parts.push(`[tool_result] ${c}`);
        else if (Array.isArray(c)) {
          const txt = (c as ContentBlock[])
            .map((x) => (x.type === "text" ? x.text ?? "" : safeJson(x)))
            .join("\n");
          parts.push(`[tool_result] ${txt}`);
        } else if (c != null) parts.push(`[tool_result] ${safeJson(c)}`);
        break;
      }
      default:
        // Unknown/future block type — keep it rather than drop it.
        parts.push(safeJson(b));
    }
  }
  return { text: parts.join("\n\n").trim(), hasToolResult };
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

// --- Adapter ------------------------------------------------------------------

export class ClaudeCodeAdapter implements Adapter {
  readonly source = "claude-code" as const;

  async discover(): Promise<DiscoveredFile[]> {
    const files = await walkJsonl(ROOT);
    const out: DiscoveredFile[] = [];
    for (const p of files) {
      const st = await fs.stat(p);
      out.push({ path: p, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  async parseFile(filePath: string, fromByte = 0): Promise<ParseResult> {
    const buf = await fs.readFile(filePath);
    // If the file shrank since last sync it was rotated/replaced -> re-read all.
    const start = fromByte > 0 && fromByte <= buf.length ? fromByte : 0;
    const slice = buf.subarray(start).toString("utf8");

    const messages: ParsedMessage[] = [];
    let model: string | null = null;
    let projectPath: string | null = null;
    let nativeId = path.basename(filePath, ".jsonl");
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
        continue; // skip a partial trailing write; we'll catch it next sync
      }

      // Session-level fields (last non-null wins for things that may repeat).
      if (line.sessionId) nativeId = line.sessionId;
      if (line.cwd) projectPath = line.cwd;
      if (line.message?.model) model = line.message.model;
      if (line.gitBranch) meta.gitBranch = line.gitBranch;
      if (line.version) meta.version = line.version;

      // A "summary" line is a good title source.
      if (line.type === "summary" && line.summary) {
        title ??= truncate(line.summary);
      }

      const { text, hasToolResult } = flatten(line.message?.content);
      // Skip empty meta lines that carry no content and aren't summaries.
      if (!text && line.type !== "summary") continue;

      let role = roleOf(line);
      if (hasToolResult && role === "user") role = "tool";

      const ts = line.timestamp ?? null;
      if (ts) {
        firstTs ??= ts;
        lastTs = ts;
      }

      // First real user prompt becomes the title if no summary line exists.
      if (!title && role === "user" && text) title = truncate(text);

      const usage = line.message?.usage;
      messages.push({
        nativeUuid: line.uuid ?? null,
        role,
        content: line.type === "summary" ? `[summary] ${line.summary}` : text,
        model: line.message?.model ?? null,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        timestamp: ts,
        raw: trimmed,
      });
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
