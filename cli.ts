import { openDb, sync } from "./db.js";
import { dbPath, migrateLegacyDataHome } from "./paths.js";
import { listSessions, searchMessages } from "./query.js";
import { runSkillsCommand } from "./skillgen.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type { Adapter } from "./adapters/adapter.js";

// Register adapters here as you add them.
const adapters: Adapter[] = [new ClaudeCodeAdapter(), new CodexAdapter(), new OpenCodeAdapter()];

async function main() {
  const [, , cmd, ...args] = process.argv;
  migrateLegacyDataHome();
  const db = openDb(dbPath());

  if (cmd === "sync" || !cmd) {
    for (const a of adapters) {
      const r = await sync(db, a);
      console.log(
        `[${a.source}] +${r.newSessions} sessions, +${r.newMessages} messages, ${r.markedDeleted} marked deleted`
      );
    }
  } else if (cmd === "search") {
    const q = args.join(" ");
    const hits = searchMessages(db, q, { limit: 20 });
    console.table(
      hits.map((h) => ({
        source: h.session.source,
        title: h.session.title,
        project_path: h.session.projectPath,
        role: h.message.role,
        snip: h.snippet,
      }))
    );
  } else if (cmd === "list") {
    const { items } = listSessions(db, { limit: 30, offset: 0 });
    console.table(
      items.map((s) => ({
        source: s.source,
        msgs: s.messageCount,
        status: s.sourceStatus,
        updated: s.updatedAt?.slice(0, 10) ?? null,
        title: s.title,
      }))
    );
  } else if (cmd === "skills") {
    await runSkillsCommand(db, args);
  } else {
    console.log(
      "usage: open-agent-memory [sync|list|search <query>|skills [path] [--report-only] [--min-support N] [--max-skills N] [--model name]]"
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
