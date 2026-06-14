// Retrieval evaluation harness.
//
// Builds a throwaway archive from the synthetic corpus (fixtures/eval-corpus.ts),
// runs each query through the shared search path (query.ts), and scores recall
// and MRR against the corpus's ground truth. This is the objective gate for
// retrieval changes: today it baselines FTS; Phase 2 reuses it to prove that
// hybrid (semantic) retrieval beats this baseline.
//
//   npm run eval
//
// Exit code is nonzero if any non-known-gap query fails (recall < 1), so it can
// guard CI. Known-gap queries (e.g. Chinese sub-phrase under FTS) are reported
// but never fail the run — they track what later phases should close.

import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { openDb } from "./db.js";
import { searchMessages, type SearchHit } from "./query.js";
import { MESSAGES, QUERIES, SESSIONS } from "./fixtures/eval-corpus.js";

const TOP_K = 10;

function buildCorpusDb(): { db: Database.Database; file: string } {
  const file = join(tmpdir(), `oam-eval-${process.pid}-${Date.now()}.db`);
  const db = openDb(file);
  const now = new Date().toISOString();

  const insSession = db.prepare(`
    INSERT INTO sessions (id, source, native_id, title, project_path,
      created_at, updated_at, source_path, source_status, archived_at, meta)
    VALUES (@id, @source, @native_id, @title, @project_path,
      @now, @now, @source_path, 'present', @now, '{}')
  `);
  const insMessage = db.prepare(`
    INSERT INTO messages (id, session_id, seq, role, content, raw)
    VALUES (@id, @session_id, @seq, @role, @content, @content)
  `);

  db.transaction(() => {
    for (const s of SESSIONS) {
      insSession.run({
        id: s.id,
        source: s.source,
        native_id: s.id,
        title: s.title,
        project_path: s.projectPath,
        source_path: `/synthetic/${s.id}`,
        now,
      });
    }
    for (const m of MESSAGES) {
      insMessage.run({
        id: m.id,
        session_id: m.sessionId,
        seq: m.seq,
        role: m.role,
        content: m.content,
      });
    }
  })();

  return { db, file };
}

interface Scored {
  query: string;
  note: string;
  knownGap: boolean;
  expected: number;
  found: number;
  recall: number;
  mrr: number;
  pass: boolean;
}

/** Reciprocal rank of the first expected id in the result list (0 if absent). */
function reciprocalRank(hits: SearchHit[], expected: Set<string>): number {
  for (let i = 0; i < hits.length; i++) {
    if (expected.has(hits[i].message.id)) return 1 / (i + 1);
  }
  return 0;
}

function run(): number {
  const { db, file } = buildCorpusDb();
  const results: Scored[] = [];

  try {
    for (const q of QUERIES) {
      const hits = searchMessages(db, q.query, {
        limit: TOP_K,
        source: q.source,
      });
      const topIds = new Set(hits.slice(0, TOP_K).map((h) => h.message.id));
      const expected = new Set(q.expected);
      const foundCount = q.expected.filter((id) => topIds.has(id)).length;
      const recall = q.expected.length === 0 ? 1 : foundCount / q.expected.length;
      const mrr = reciprocalRank(hits, expected);
      const pass = q.knownGap ? true : recall >= 1;
      results.push({
        query: q.query,
        note: q.note,
        knownGap: !!q.knownGap,
        expected: q.expected.length,
        found: foundCount,
        recall,
        mrr,
        pass,
      });
    }
  } finally {
    db.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  }

  // --- Report ---
  console.log("\nRetrieval eval (FTS baseline)\n");
  console.table(
    results.map((r) => ({
      query: r.query,
      "recall@10": r.recall.toFixed(2),
      mrr: r.mrr.toFixed(2),
      "found/exp": `${r.found}/${r.expected}`,
      status: r.knownGap ? "KNOWN GAP" : r.pass ? "pass" : "FAIL",
    }))
  );

  const scored = results.filter((r) => !r.knownGap);
  const meanRecall =
    scored.reduce((a, r) => a + r.recall, 0) / (scored.length || 1);
  const meanMrr = scored.reduce((a, r) => a + r.mrr, 0) / (scored.length || 1);
  const failures = scored.filter((r) => !r.pass);
  const gaps = results.filter((r) => r.knownGap);

  console.log(
    `\nscored queries: ${scored.length}  mean recall@10: ${meanRecall.toFixed(
      2
    )}  mean MRR: ${meanMrr.toFixed(2)}`
  );
  if (gaps.length) {
    console.log(`known gaps (tracked for Phase 2): ${gaps.length}`);
    for (const g of gaps) console.log(`  · "${g.query}" — ${g.note}`);
  }

  if (failures.length) {
    console.log(`\n${failures.length} FAILED:`);
    for (const f of failures) {
      console.log(`  · "${f.query}" recall ${f.recall.toFixed(2)} — ${f.note}`);
    }
    return 1;
  }
  console.log("\nall scored queries passed.");
  return 0;
}

process.exit(run());
