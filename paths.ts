import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Data home ------------------------------------------------------------------
// Everything this tool writes lives under one directory. Historically it was
// ~/.ai-sessions; the project rename moved it to ~/.open-agent-memory, and
// migrateLegacyDataHome() carries existing archives across exactly once.

/** Root directory for all data this tool writes. Env override is for tests. */
export function dataHome(): string {
  return (
    process.env.OPEN_AGENT_MEMORY_HOME ??
    path.join(os.homedir(), ".open-agent-memory")
  );
}

export function dbPath(): string {
  return path.join(dataHome(), "archive.db");
}

/** Where generated skills + mining reports are written (review area). */
export function skillsHome(): string {
  return path.join(dataHome(), "skills");
}

const LEGACY_DIR = () => path.join(os.homedir(), ".ai-sessions");

/**
 * One-time, idempotent migration of the archive from ~/.ai-sessions to the
 * current data home. Call before openDb(). Never deletes the legacy copy on
 * the copy path, and never moves a partially-checkpointed database.
 * Skipped entirely when OPEN_AGENT_MEMORY_HOME is set (tests must not pull
 * real data into a temp dir).
 */
export function migrateLegacyDataHome(): void {
  mkdirSync(dataHome(), { recursive: true });
  if (process.env.OPEN_AGENT_MEMORY_HOME) return;

  const newDb = dbPath();
  const oldDb = path.join(LEGACY_DIR(), "archive.db");
  if (existsSync(newDb)) {
    if (existsSync(oldDb)) {
      console.error(
        `note: legacy archive at ${oldDb} exists but is ignored (using ${newDb})`
      );
    }
    return;
  }
  if (!existsSync(oldDb)) return; // fresh install

  // Fold the WAL into the main file so a single-file move is safe.
  let checkpointed = false;
  try {
    const old = new Database(oldDb);
    old.pragma("wal_checkpoint(TRUNCATE)");
    old.close();
    checkpointed = true;
  } catch {
    // Another process may hold the db; fall through to copying everything.
  }

  if (checkpointed) {
    moveFile(oldDb, newDb);
    // Stragglers from an unclean shutdown; harmless if absent.
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(oldDb + ext)) moveFile(oldDb + ext, newDb + ext);
    }
  } else {
    // Could not checkpoint: copy db + sidecars together, leave originals.
    for (const ext of ["", "-wal", "-shm"]) {
      if (existsSync(oldDb + ext)) copyFileSync(oldDb + ext, newDb + ext);
    }
  }
  console.error(`migrated archive: ${LEGACY_DIR()} → ${dataHome()}`);
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(from, to); // cross-device: copy and keep the original
  }
}
