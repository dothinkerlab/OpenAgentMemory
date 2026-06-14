// Synthetic evaluation corpus for retrieval scoring.
//
// Why synthetic and not the real archive: the eval must be self-contained and
// reproducible in CI on any machine. Content-derived session/message ids in a
// personal archive are not portable, so we hand-build a small corpus with known
// ground truth instead. Keep it small but representative: English, Chinese,
// code symbols, a cross-tool continuation, and noise for precision.
//
// This is the objective gate for Phase 2 (semantic search): the same queries
// run against FTS today and hybrid retrieval later, so the gain is measurable.

import type { Source } from "../model.js";

export interface CorpusSession {
  id: string;
  source: Source;
  projectPath: string;
  title: string;
}

export interface CorpusMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

export const SESSIONS: CorpusSession[] = [
  { id: "s-oauth-cc", source: "claude-code", projectPath: "/demo/web", title: "OAuth setup" },
  // Cross-tool continuation of the same task, in a different tool, same project.
  { id: "s-oauth-cx", source: "codex", projectPath: "/demo/web", title: "OAuth follow-up" },
  { id: "s-mig", source: "claude-code", projectPath: "/demo/api", title: "迁移脚本" },
  { id: "s-code", source: "opencode", projectPath: "/demo/api", title: "adapter internals" },
  { id: "s-noise", source: "claude-code", projectPath: "/demo/ui", title: "layout" },
];

export const MESSAGES: CorpusMessage[] = [
  // OAuth task — English (claude-code)
  {
    id: "m-oauth-1",
    sessionId: "s-oauth-cc",
    seq: 0,
    role: "user",
    content: "How do I configure OAuth authentication with refresh tokens?",
  },
  {
    id: "m-oauth-2",
    sessionId: "s-oauth-cc",
    seq: 1,
    role: "assistant",
    content:
      "Set up the OAuth client, store the refresh token securely, and rotate it on each use.",
  },
  // OAuth task continued in Codex — cross-tool follow-up
  {
    id: "m-oauth-3",
    sessionId: "s-oauth-cx",
    seq: 0,
    role: "user",
    content: "Continue the OAuth task from earlier.",
  },
  {
    id: "m-oauth-4",
    sessionId: "s-oauth-cx",
    seq: 1,
    role: "assistant",
    content:
      "Implemented refresh token rotation and added the authentication middleware.",
  },
  // Migration task — Chinese (claude-code)
  {
    id: "m-mig-1",
    sessionId: "s-mig",
    seq: 0,
    role: "user",
    content: "帮我写一个数据库迁移脚本。",
  },
  {
    id: "m-mig-2",
    sessionId: "s-mig",
    seq: 1,
    role: "assistant",
    content: "迁移脚本 已经写好,使用 user_version 跟踪版本。",
  },
  // Code symbols (opencode)
  {
    id: "m-code-1",
    sessionId: "s-code",
    seq: 0,
    role: "assistant",
    content: "The parseFile function opens the sqlite db in readonly mode.",
  },
  // Noise — should not match the queries above
  {
    id: "m-noise-1",
    sessionId: "s-noise",
    seq: 0,
    role: "assistant",
    content: "Use flexbox with justify-content center to center the layout.",
  },
];

export interface EvalQuery {
  query: string;
  source?: Source;
  /** Message ids that a good retriever should surface (ground truth). */
  expected: string[];
  /**
   * A query FTS is known to miss today (e.g. Chinese sub-phrase that crosses
   * token boundaries). Reported but does not fail the suite — it tracks the gap
   * Phase 2 semantic search should close.
   */
  knownGap?: boolean;
  note: string;
}

export const QUERIES: EvalQuery[] = [
  {
    query: "refresh token",
    expected: ["m-oauth-2", "m-oauth-4"],
    note: "Cross-tool recall: the literal term appears in both the claude-code (m-oauth-2) and Codex (m-oauth-4) sessions.",
  },
  {
    query: "authentication middleware",
    expected: ["m-oauth-4"],
    note: "Specific phrase, single hit.",
  },
  {
    query: "refresh token",
    source: "codex",
    expected: ["m-oauth-4"],
    note: "Source filter: same term, but must exclude the claude-code message m-oauth-2.",
  },
  {
    query: "迁移脚本",
    expected: ["m-mig-2"],
    note: "Chinese exact-token match (standalone 迁移脚本).",
  },
  {
    query: "parseFile",
    expected: ["m-code-1"],
    note: "Code symbol retrieval.",
  },
  {
    query: "OAuth refresh token",
    expected: ["m-oauth-1", "m-oauth-2", "m-oauth-4"],
    knownGap: true,
    note: "Semantic + morphology gap: FTS AND-semantics drop m-oauth-4 (the cross-tool continuation has no literal 'OAuth'), and no stemming means 'token' misses 'tokens' in m-oauth-1. Phase 2 target.",
  },
  {
    query: "迁移",
    expected: ["m-mig-1", "m-mig-2"],
    knownGap: true,
    note: "Chinese sub-phrase: FTS5 unicode61 tokenizes Han runs whole, so '迁移' cannot match the token '数据库迁移脚本' / '迁移脚本'. Phase 2 target.",
  },
];
