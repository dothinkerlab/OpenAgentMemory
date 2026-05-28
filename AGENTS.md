# AGENTS.md

Guidance for AI coding agents working in this repo. Read this before making changes.

## What this is

A local-first tool that **archives and searches the session logs of multiple AI
coding tools** (Claude Code, Codex, Gemini CLI, OpenCode, Trae, …). Each tool
stores conversations in its own location and format; this project normalizes them
into one SQLite database with full-text search.

Stack: **TypeScript + Node.js (ESM)**, `better-sqlite3` (synchronous, FTS5).
A web UI (Hono/Express + React/Vite) is planned but not yet built.

## Architecture (3 layers)

```
adapters/  ── one per tool: discover() + parseFile() → normalized records
   ↓
db.ts      ── ingest engine: incremental sync, dedup, FTS; the source of truth
   ↓
cli.ts     ── (later: REST API + web UI)
```

- `src/model.ts` — the shared `Session` / `Message` types. The whole app speaks these.
- `src/adapters/adapter.ts` — the `Adapter` interface every tool implements.
- `src/adapters/claude-code.ts` — reference adapter (JSONL). Mirror its structure.
- `src/db.ts` — schema + `sync()`. Touch carefully (see invariants).
- `src/cli.ts` — entry point; register new adapters in the `adapters[]` array here.

## Non-negotiable invariants

These are the design; do not "simplify" them away.

1. **Adapters are strictly read-only against source files.** The source tools may
   be running and writing concurrently. Never open a source file for write, never
   move/delete it. For SQLite sources (e.g. Trae's `state.vscdb`), open read-only
   (`readonly: true` / `mode=ro`) or copy to a temp file first to avoid lock conflicts.

2. **Archive-first, never lose the original.** Every `messages` row stores `raw`
   (the verbatim source line/record). If a format changes we re-derive from `raw`.
   Do not drop fields you don't recognize — stash them rather than discard.

3. **Source deletion = mark, not delete.** When a source file disappears, the
   session is marked `source_status = 'deleted'` and **kept**. Outliving the source
   tools is the entire point. Never `DELETE FROM sessions` during a sync.

4. **Sync is incremental and idempotent.** JSONL is append-only: `sync_state` tracks
   a byte offset and we only read the tail. Re-running `sync` must never duplicate
   rows (dedup is via stable ids + `INSERT OR IGNORE`). If a file shrank, it was
   rotated → re-read from byte 0.

5. **Stable ids are content-derived.** `session.id = sha1(source:nativeId)`,
   `message.id = sha1(source:nativeUuid)` (or `sha1(sessionId:seq)` fallback). Keep
   this scheme so the same source always maps to the same row.

6. **Format tolerance.** These tools' formats evolve across versions. Parse
   defensively: unknown record/block `type`s should be preserved, not crash the run.
   A malformed trailing line (a partial concurrent write) is skipped, not fatal.

## Commands

```bash
npm install
npm run dev            # run the CLI via tsx (no build step)
npm run sync           # discover + archive all registered adapters
npm run list           # recent sessions
npm run search "<q>"   # FTS5 search
npm run build          # tsc → dist/
```

The archive DB lives at `~/.ai-sessions/archive.db`. Source data lives under each
tool's own dir (e.g. `~/.claude/projects/`) and is never modified.

## Conventions

- ESM throughout: **use `.js` extensions in relative imports** (`./db.js`), even
  though the source is `.ts` — required by `moduleResolution: NodeNext`.
- `strict` TypeScript. No `any` in committed code; loose external JSON is typed with
  intentionally-optional interface fields (see `RawLine` in the Claude Code adapter).
- `better-sqlite3` is synchronous — no `await` on DB calls. Wrap multi-statement
  writes in `db.transaction(...)`.
- Keep adapters free of DB knowledge. They return plain parsed records; `db.ts`
  owns all persistence, id generation, and dedup.

## Adding a new adapter (the common task)

1. **Verify the real format first.** Do not guess paths or fields from memory —
   inspect an actual install. For JSONL: `head -3 <file> | jq .`. For SQLite:
   `sqlite3 -readonly <file> '.tables'` then inspect the relevant table.
2. Create `src/adapters/<tool>.ts` implementing `Adapter`:
   - `discover()` returns `DiscoveredFile[]` (path + size + mtime). Return `[]` if
     the tool isn't installed; that's normal, not an error.
   - `parseFile(path, fromByte?)` returns `{ session, messages, newByteOffset }`.
     Honor `fromByte` for append-only formats; ignore it (re-parse fully) otherwise.
   - Normalize content to readable plain text in `message.content` (this is what
     FTS searches); keep the original in `message.raw`.
3. Add the tool's literal to the `Source` union in `src/model.ts`.
4. Register an instance in the `adapters[]` array in `src/cli.ts`.
5. Test against a real copy of the data and confirm `npm run sync` then
   `npm run search` returns sensible hits.

Do **not** modify `db.ts`'s schema or sync logic to accommodate one tool — if a
tool doesn't fit the model, raise it rather than special-casing the core.

## Known per-tool notes

- **Claude Code** (done): `~/.claude/projects/<encoded-cwd>/*.jsonl`. Dir name is a
  lossy encoding of the cwd — read the reliable `cwd` field inside each line instead
  of decoding the dir. Old sessions get compacted/removed by the tool (hence archiving).
- **Codex**: JSONL, similar shape — likely the smallest next adapter.
- **Trae**: VS Code derivative; data is in a SQLite `state.vscdb`. Open read-only.

## Out of scope / do not do

- No network calls during sync. This is a local tool; data must not leave the machine.
- Do not add telemetry, auto-update, or anything that writes outside `~/.ai-sessions/`.
- Do not introduce an ORM or a second database engine; SQLite + raw SQL is deliberate.
