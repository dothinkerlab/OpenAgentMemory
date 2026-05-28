// Unified data model shared across the whole app (backend + frontend).
// Every adapter normalizes its tool's native format into these shapes.

export type Source =
  | "claude-code"
  | "codex"
  | "gemini"
  | "opencode"
  | "trae";

export type Role = "user" | "assistant" | "tool" | "system";

/** A conversation, normalized from whatever tool produced it. */
export interface Session {
  /** Global stable id = sha1(`${source}:${nativeId}`). */
  id: string;
  source: Source;
  /** The tool's own session id (e.g. the JSONL file's session uuid). */
  nativeId: string;
  title: string | null;
  /** Working directory / project the session belongs to. */
  projectPath: string | null;
  /** Primary model used in the session. */
  model: string | null;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** ISO timestamp of the first message. */
  createdAt: string | null;
  /** ISO timestamp of the last message. */
  updatedAt: string | null;
  /** Absolute path to the original source file (the "pointer"). */
  sourcePath: string;
  /** Whether the original still exists on disk. */
  sourceStatus: "present" | "deleted";
  /** When we ingested/archived it. */
  archivedAt: string;
  /** Source-specific extras we don't want to lose (gitBranch, version, ...). */
  meta: Record<string, unknown>;
}

/** A single message inside a session. */
export interface Message {
  /** Stable id, prefers the native uuid; falls back to `${sessionId}:${seq}`. */
  id: string;
  sessionId: string;
  /** Order within the session (0-based, monotonic). */
  seq: number;
  role: Role;
  /** Flattened, human-readable text used for display and full-text search. */
  content: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  timestamp: string | null;
  /** The original line/record, verbatim. Never lose the source of truth. */
  raw: string;
}
