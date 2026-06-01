import os from "node:os";
import path from "node:path";
import { openDb, sync } from "./db.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type { Adapter } from "./adapters/adapter.js";

// Register adapters here as you add them.
const adapters: Adapter[] = [new ClaudeCodeAdapter(), new CodexAdapter(), new OpenCodeAdapter()];

const DB_PATH = path.join(os.homedir(), ".ai-sessions", "archive.db");

async function main() {
  const [, , cmd, ...args] = process.argv;
  const db = openDb(DB_PATH);

  if (cmd === "sync" || !cmd) {
    for (const a of adapters) {
      const r = await sync(db, a);
      console.log(
        `[${a.source}] +${r.newSessions} sessions, +${r.newMessages} messages, ${r.markedDeleted} marked deleted`
      );
    }
  } else if (cmd === "search") {
    const q = args.join(" ");
    const rows = db
      .prepare(
        `SELECT s.source, s.title, s.project_path, m.role,
                snippet(messages_fts, 0, '«', '»', '…', 12) AS snip
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ?
         ORDER BY rank LIMIT 20`
      )
      .all(q);
    console.table(rows);
  } else if (cmd === "list") {
    const rows = db
      .prepare(
        `SELECT source, message_count AS msgs, source_status AS status,
                substr(updated_at,1,10) AS updated, title
         FROM sessions ORDER BY updated_at DESC LIMIT 30`
      )
      .all();
    console.table(rows);
  } else {
    console.log("usage: open-agent-memory [sync|list|search <query>]");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
