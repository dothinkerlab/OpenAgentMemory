import type { Source, Role } from "../model.js";

/** A source file the adapter found on disk, with stat info for sync decisions. */
export interface DiscoveredFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** Session-level fields an adapter extracts from a file. */
export interface ParsedSession {
  nativeId: string;
  source: Source;
  title: string | null;
  projectPath: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sourcePath: string;
  meta: Record<string, unknown>;
}

/** A message an adapter extracts. `seq` is assigned later by the ingest engine. */
export interface ParsedMessage {
  nativeUuid: string | null;
  role: Role;
  content: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  timestamp: string | null;
  raw: string;
}

export interface ParseResult {
  session: ParsedSession;
  /** New messages found *after* `fromByte` (so re-syncs only return the tail). */
  messages: ParsedMessage[];
  /** Where to resume next time. Equals file size after a full read. */
  newByteOffset: number;
}

/**
 * Each tool gets one adapter. Adding a new tool = adding one file that
 * implements this interface; the core ingest/search/UI never changes.
 *
 * Adapters are STRICTLY READ-ONLY against the source files.
 */
export interface Adapter {
  source: Source;
  /** Find every session file for this tool. */
  discover(): Promise<DiscoveredFile[]>;
  /**
   * Parse a single file. For append-only formats (JSONL), pass the byte offset
   * we last read up to so we only parse newly appended lines. For formats that
   * aren't append-only, the adapter ignores `fromByte` and re-parses fully.
   */
  parseFile(filePath: string, fromByte?: number): Promise<ParseResult>;
}
