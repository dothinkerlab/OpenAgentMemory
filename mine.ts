import type Database from "better-sqlite3";
import path from "node:path";

// --- Pattern mining -------------------------------------------------------------
// Read-only analysis over the archive: given a project path, find repeated
// behaviors across its sessions. Two miners:
//   A. command-sequence — recurring n-grams of normalized tool/shell events
//   B. convention       — clusters of similar user corrections ("不要…", "don't…")
// Everything here is heuristic and local; semantic write-up happens in skillgen.

export interface Evidence {
  sessionIds: string[];
  /** Total occurrences (may be inflated by sources that duplicate lines). */
  occurrences: number;
  /** Distinct sessions the pattern appears in — the support metric. */
  sessionCount: number;
  snippets: string[];
}

export interface SkillCandidate {
  kind: "command-sequence" | "convention";
  slug: string;
  summary: string;
  /** Normalized event sequence, or representative correction messages. */
  items: string[];
  evidence: Evidence;
}

export interface MineOptions {
  minSequenceSupport: number;
  minConventionSupport: number;
  maxCandidates: number;
}

export const DEFAULT_MINE_OPTIONS: MineOptions = {
  minSequenceSupport: 3,
  minConventionSupport: 2,
  maxCandidates: 10,
};

export interface MineResult {
  projectPath: string;
  sessionsScanned: number;
  candidates: SkillCandidate[];
}

interface Msg {
  seq: number;
  role: string;
  content: string;
}

export function mineProject(
  db: Database.Database,
  projectPath: string,
  opts: MineOptions
): MineResult {
  const root = path.resolve(projectPath).replace(/\/+$/, "");
  const sessions = db
    .prepare(
      `SELECT id FROM sessions
       WHERE project_path = ? OR project_path LIKE ? || '/%'`
    )
    .all(root, root) as { id: string }[];

  const getMsgs = db.prepare(
    `SELECT seq, role, content FROM messages
     WHERE session_id = ? AND content IS NOT NULL ORDER BY seq`
  );

  const sequenceCands: SkillCandidate[] = [];
  const conventionCands: SkillCandidate[] = [];
  const seqMiner = new SequenceMiner();
  const convMiner = new ConventionMiner();

  for (const { id } of sessions) {
    const msgs = getMsgs.all(id) as Msg[];
    seqMiner.addSession(id, msgs);
    convMiner.addSession(id, msgs);
  }
  sequenceCands.push(...seqMiner.candidates(opts.minSequenceSupport));
  conventionCands.push(...convMiner.candidates(opts.minConventionSupport));

  // Reserve up to a third of the slots for conventions so frequent command
  // grams don't crowd them out entirely.
  const convSlots = Math.min(
    conventionCands.length,
    Math.max(1, Math.floor(opts.maxCandidates / 3))
  );
  const candidates = [
    ...sequenceCands.slice(0, opts.maxCandidates - convSlots),
    ...conventionCands.slice(0, convSlots),
  ].slice(0, opts.maxCandidates);
  return { projectPath: root, sessionsScanned: sessions.length, candidates };
}

// --- Miner A: command/tool sequences --------------------------------------------

/** Tool names whose invocations are shell commands with a JSON input. */
const SHELL_TOOLS = new Set(["bash", "exec_command", "shell", "run_terminal_cmd"]);

/** Tools that are navigation/editing noise, never a workflow step. */
const TOOL_STOPLIST = new Set([
  "read", "edit", "write", "multiedit", "notebookedit", "grep", "glob", "ls",
  "view_image", "todowrite", "todoread", "update_plan", "task", "agent",
  "websearch", "webfetch", "askuserquestion", "exitplanmode", "toolsearch",
  "write_stdin", "skill", "request_user_input",
]);

/** Shell first-tokens that are inspection noise, not workflow steps. */
const SHELL_STOPWORDS = new Set([
  "cd", "ls", "cat", "echo", "pwd", "which", "head", "tail", "grep", "find",
  "sed", "awk", "wc", "sort", "jq", "true", "sleep", "env", "printf", "rg",
  "apply_patch", "fd", "tree", "stat", "file", "date", "nl",
]);

/** First tokens whose subcommand matters (`git push`, `npm test`, …). */
const TWO_WORD_PREFIX = new Set([
  "git", "npm", "pnpm", "yarn", "npx", "cargo", "docker", "kubectl", "pod",
  "bundle", "fastlane", "make", "go", "python", "python3", "pip", "pip3",
  "swift", "gradle", "mvn", "gh", "node", "tsx", "xcodebuild", "flutter",
  "dotnet", "rake", "composer", "uv",
]);

const TOOL_LINE = /^\[tool: ([^\]]+)\]\s*(.*)$/;

interface SessionEvents {
  sessionId: string;
  /** Normalized event tokens, consecutive duplicates collapsed. */
  events: string[];
}

class SequenceMiner {
  private sessions: SessionEvents[] = [];
  /** normalized token → verbatim example commands (for evidence snippets). */
  private examples = new Map<string, Set<string>>();

  addSession(sessionId: string, msgs: Msg[]): void {
    const events: string[] = [];
    const seenContent = new Set<string>(); // codex duplicates whole messages
    for (const m of msgs) {
      // claude-code records tool calls on assistant messages; codex/opencode
      // record them on tool-role messages. Tool *results* never match TOOL_LINE.
      if (m.role !== "assistant" && m.role !== "tool") continue;
      if (seenContent.has(m.content)) continue;
      seenContent.add(m.content);
      for (const line of m.content.split("\n")) {
        const match = TOOL_LINE.exec(line);
        if (!match) continue;
        for (const ev of this.normalize(match[1], match[2])) {
          if (events[events.length - 1] !== ev) events.push(ev);
        }
      }
    }
    if (events.length > 0) this.sessions.push({ sessionId, events });
  }

  /** One tool line can yield several events (cmd1 && cmd2), or none (noise). */
  private normalize(toolName: string, rest: string): string[] {
    const name = toolName.toLowerCase();
    if (TOOL_STOPLIST.has(name)) return [];
    if (!SHELL_TOOLS.has(name)) return [`tool:${name}`];

    let command: string | null = null;
    try {
      const input = JSON.parse(rest) as Record<string, unknown>;
      const c = input.command ?? input.cmd;
      if (typeof c === "string") command = c;
      else if (Array.isArray(c)) command = c.map(String).join(" ");
    } catch {
      // opencode-style: no JSON input recorded → coarse event only
      return [`tool:${name}`];
    }
    if (!command) return [`tool:${name}`];

    const out: string[] = [];
    for (const sub of command.split(/&&|\|\||;|\n/)) {
      const token = normalizeShellCommand(sub);
      if (token) {
        out.push(`sh:${token}`);
        let ex = this.examples.get(`sh:${token}`);
        if (!ex) this.examples.set(`sh:${token}`, (ex = new Set()));
        if (ex.size < 5) ex.add(sub.trim().slice(0, 200));
      }
      // Everything after a heredoc opener is its body, not more commands.
      if (sub.includes("<<")) break;
    }
    return out;
  }

  candidates(minSupport: number): SkillCandidate[] {
    interface Stat {
      sessions: Set<string>;
      occurrences: number;
    }
    const grams = new Map<string, Stat>();
    for (const { sessionId, events } of this.sessions) {
      for (let n = 2; n <= 5; n++) {
        for (let i = 0; i + n <= events.length; i++) {
          const key = events.slice(i, i + n).join(" → ");
          let st = grams.get(key);
          if (!st) grams.set(key, (st = { sessions: new Set(), occurrences: 0 }));
          st.sessions.add(sessionId);
          st.occurrences++;
        }
      }
    }

    let kept = [...grams.entries()]
      .filter(([, st]) => st.sessions.size >= minSupport)
      .map(([key, st]) => ({ key, steps: key.split(" → "), st }));

    // Prefer maximal patterns: drop a gram contained in a longer one that
    // retains ≥80% of its support.
    kept.sort((a, b) => b.steps.length - a.steps.length);
    const survivors: typeof kept = [];
    for (const g of kept) {
      const swallowed = survivors.some(
        (h) =>
          h.steps.length > g.steps.length &&
          h.key.includes(g.key) &&
          h.st.sessions.size >= 0.8 * g.st.sessions.size
      );
      if (!swallowed) survivors.push(g);
    }

    survivors.sort(
      (a, b) =>
        b.st.sessions.size * b.steps.length - a.st.sessions.size * a.steps.length
    );

    // Diversity: permutations/subsets of the same few commands make near-
    // identical skills. Greedily keep the best of each step-set family.
    const picked: typeof survivors = [];
    for (const g of survivors) {
      const set = new Set(g.steps);
      const similar = picked.some((p) => {
        const pset = new Set(p.steps);
        return jaccard(pset, set) >= 0.5;
      });
      if (!similar) picked.push(g);
    }

    return picked.map((g) => {
      const snippets: string[] = [];
      for (const step of g.steps) {
        for (const ex of [...(this.examples.get(step) ?? [])].slice(0, 3)) {
          snippets.push(`${step}: ${ex}`);
        }
      }
      const pretty = g.steps.map((s) => s.replace(/^(sh|tool):/, ""));
      return {
        kind: "command-sequence" as const,
        slug: sequenceSlug(g.steps),
        summary: `Repeated workflow: ${pretty.join(" → ")} (in ${g.st.sessions.size} sessions)`,
        items: g.steps,
        evidence: {
          sessionIds: [...g.st.sessions],
          occurrences: g.st.occurrences,
          sessionCount: g.st.sessions.size,
          snippets: snippets.slice(0, 15),
        },
      };
    });
  }
}

/** Shell control flow — never a workflow step in itself. */
const SHELL_KEYWORDS = new Set([
  "for", "while", "until", "if", "elif", "fi", "done", "esac", "case",
  "function", "return", "exit", "break", "continue", "local", "set", "trap",
  "shift", "eval", "source", "read", "{", "}", "(", ")", "!", "[", "[[",
]);

/** `FOO=1 sudo npm run lint --fix` → `npm run lint`; noise/empty → null. */
function normalizeShellCommand(sub: string): string | null {
  const words = sub.trim().split(/\s+/).filter(Boolean);
  // Strip wrappers that prefix the real command.
  while (
    words.length > 0 &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) ||
      ["sudo", "do", "then", "else", "time", "command", "exec"].includes(words[0]))
  ) {
    words.shift();
  }
  if (words.length === 0 || SHELL_KEYWORDS.has(words[0])) return null;
  const first = words[0].replace(/^\.\//, "").split("/").pop() ?? words[0];
  if (SHELL_STOPWORDS.has(first)) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(first)) return null; // subshells, redirects, etc.

  const parts = [first];
  if (TWO_WORD_PREFIX.has(first)) {
    // Find the subcommand, hopping over pre-subcommand flags (`git -C <dir>
    // status`) and version pins (`bundle _2.5.22_ install`).
    let i = 1;
    while (words[i] && (words[i].startsWith("-") || /^_[\d.]+_$/.test(words[i]))) {
      i += ["-C", "-c"].includes(words[i]) ? 2 : 1;
    }
    const sub = words[i];
    if (sub && /^[a-z0-9:._-]+$/i.test(sub) && !sub.startsWith("-")) {
      parts.push(sub);
      // `npm run <script>` / `bundle exec <cmd>`: the third word is the verb
      if ((sub === "run" || sub === "exec") && words[i + 1] && !words[i + 1].startsWith("-")) {
        parts.push(words[i + 1]);
      }
    }
  }
  return parts.join(" ");
}

function sequenceSlug(steps: string[]): string {
  const clean = (s: string) => slugify(s.replace(/^(sh|tool):/, ""));
  const distinct = [...new Set(steps.map(clean))].slice(0, 3);
  return distinct.join("-then-").slice(0, 48).replace(/-+$/, "") || "workflow";
}

// --- Miner B: corrections / conventions ------------------------------------------

const EN_MARKERS =
  /\b(don'?t|do not|stop|never|wrong|incorrect|instead|actually|you should|shouldn'?t|should have|remember to|always|not like that|use \S+ instead)\b/i;
// "别" alone matches 特别/级别/区别 — require a verb-ish continuation.
const ZH_MARKERS =
  /不要|别(再|忘|用|改|动|删|加)|不对|不是这样|错了|有错|应该|记得|改成|改用|换成|注意|必须|禁止|不能/;

/** Boilerplate that looks like a user message but isn't a human correction. */
const NOT_A_CORRECTION =
  /^\[|<system-reminder>|<command-name>|<local-command|^Caveat:|<task notes>/;

interface ClusterMember {
  sessionId: string;
  text: string;
}

class ConventionMiner {
  private clusters: { centroid: Set<string>; members: ClusterMember[] }[] = [];
  private seen = new Set<string>(); // `${sessionId}\n${text}` dedup

  addSession(sessionId: string, msgs: Msg[]): void {
    for (const m of msgs) {
      if (m.role !== "user" || m.seq === 0) continue;
      const text = m.content.trim();
      if (text.length < 3 || text.length > 400) continue;
      if (NOT_A_CORRECTION.test(text) || text.includes("[tool:")) continue;
      if (!EN_MARKERS.test(text) && !ZH_MARKERS.test(text)) continue;
      const key = `${sessionId}\n${text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.assign({ sessionId, text });
    }
  }

  /** Greedy single-link clustering on token/CJK-bigram shingles. */
  private assign(member: ClusterMember): void {
    const sh = shingles(member.text);
    for (const c of this.clusters) {
      if (jaccard(c.centroid, sh) >= 0.35) {
        c.members.push(member);
        return;
      }
    }
    this.clusters.push({ centroid: sh, members: [member] });
  }

  candidates(minSupport: number): SkillCandidate[] {
    const kept = this.clusters
      .map((c) => ({
        members: c.members,
        sessions: new Set(c.members.map((m) => m.sessionId)),
      }))
      .filter((c) => c.sessions.size >= minSupport && c.members.length >= 2)
      .sort((a, b) => b.sessions.size - a.sessions.size);

    return kept.map((c, i) => {
      const texts = [...new Set(c.members.map((m) => m.text))];
      return {
        kind: "convention" as const,
        slug: conventionSlug(texts[0], i),
        summary: `Repeated correction: "${texts[0].slice(0, 80)}" (in ${c.sessions.size} sessions)`,
        items: texts.slice(0, 5),
        evidence: {
          sessionIds: [...c.sessions],
          occurrences: c.members.length,
          sessionCount: c.sessions.size,
          snippets: texts.slice(0, 5).map((t) => t.slice(0, 200)),
        },
      };
    });
  }
}

function shingles(s: string): Set<string> {
  const out = new Set<string>();
  const lower = s.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_./-]{2,}/g)) out.add(m[0]);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function conventionSlug(text: string, index: number): string {
  const slug = slugify(text).slice(0, 40).replace(/-+$/, "");
  return slug.length >= 4 ? slug : `convention-${index + 1}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
