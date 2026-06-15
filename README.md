[English](#english) | 中文

---

# OpenAgentMemory

> 本地优先的 AI 编程工具会话存档与全文搜索工具

将 Claude Code、Codex、OpenCode 等多款 AI 编程工具的会话记录统一归档到本地 SQLite 数据库，支持 FTS5 全文搜索。数据不离本机，源文件只读，归档永不丢失。

> **终极目标：打通各家厂商 Agent 的历史数据，让 AI 的记忆真正属于你。** 换工具，但不丢上下文。

## 功能特性

- **多工具统一归档** — 目前支持 Claude Code、Codex、OpenCode；Gemini、Trae 计划中
- **增量同步，幂等** — JSONL 按字节偏移追加读取，重复运行不产生重复数据
- **源文件只读** — 适配器严格只读源文件，不会干扰正在运行的工具
- **归档永不删除** — 源文件消失后会话标记为 `deleted` 并保留，活得比工具本身更久
- **FTS5 全文搜索** — 搜索命中以 `«关键词»` 高亮显示
- **Web UI** — React 三列布局：过滤器 | 会话列表 | 消息详情
- **REST API** — Hono 驱动，支持分页、来源过滤、全文搜索

## 架构

```
adapters/          ← 每个工具一个适配器：discover() + parseFile() → 标准化记录
    │
    ▼
db.ts              ← 摄入引擎：增量同步、去重、FTS5 索引维护
    │
    ▼
SQLite 归档        ← ~/.open-agent-memory/archive.db
    │
   ┌┴──────────────┐
   ▼               ▼
cli.ts          server.ts    ← REST API（Hono，端口 8787）
                mcp.ts       ← 本地 MCP 记忆服务（stdio，只读）
                   │
                   ▼
               web/           ← React + Vite 前端（端口 5173）
```

**核心文件：**

| 文件 | 说明 |
|------|------|
| `model.ts` | 统一的 `Session` / `Message` 类型定义 |
| `adapters/adapter.ts` | `Adapter` 接口，所有适配器实现此接口 |
| `adapters/claude-code.ts` | Claude Code 适配器（参考实现） |
| `adapters/codex.ts` | Codex 适配器 |
| `adapters/opencode.ts` | OpenCode 适配器（SQLite） |
| `db.ts` | 数据库 schema + `sync()` 摄入引擎 |
| `cli.ts` | 命令行入口，适配器在此注册 |
| `server.ts` | REST API 服务 |
| `paths.ts` | 数据目录定位 + 旧目录（`~/.ai-sessions/`）自动迁移 |
| `mine.ts` | 模式挖掘：重复命令序列、反复纠正（`skills` 命令的分析层） |
| `skillgen.ts` | 调用本机 `claude` CLI 将挖掘结果生成 SKILL.md |

## 支持的 AI 工具

| 工具 | 状态 | 数据路径 | 格式 |
|------|------|----------|------|
| Claude Code | ✅ | `~/.claude/projects/**/*.jsonl` | JSONL |
| Codex | ✅ | `~/.codex/sessions/**/*.jsonl`<br>`~/.codex/archived_sessions/` | JSONL |
| OpenCode | ✅ | `~/.local/share/opencode/opencode.db` | SQLite |
| Gemini CLI | 🔜 计划中 | — | — |
| Trae | 🔜 计划中 | — | — |

## 快速开始

```bash
git clone <repo-url> OpenAgentMemory
cd OpenAgentMemory
npm install

npm run sync          # 发现并归档所有已安装工具的会话
npm run list          # 查看最近 30 条会话
npm run search "关键词"  # 全文搜索
```

## 命令

| 命令 | 说明 |
|------|------|
| `npm run sync` | 发现并增量归档所有工具的会话 |
| `npm run list` | 列出最近 30 条会话（来源、消息数、更新时间、标题） |
| `npm run search "<q>"` | FTS5 全文搜索，返回前 20 条命中结果 |
| `npm run skills -- [path]` | 从某项目的归档会话中挖掘重复行为并生成 skills（见下） |
| `npm run serve` | 启动 REST API 服务（端口 8787） |
| `npm run mcp` | 启动本地 MCP 记忆服务（stdio，只读） |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm run dev` | 通过 `tsx` 直接运行 CLI（无需编译） |

归档数据库位置：`~/.open-agent-memory/archive.db`（首次运行时自动从旧的
`~/.ai-sessions/` 迁移）

MCP 服务只暴露只读查询工具（搜索、列出会话、读取会话、读取消息），不会触发 sync、
执行 SQL、读取源文件或返回消息的原始 `raw` 记录。

## 生成 skills（实验性）

分析一个项目/文件夹下的全部归档会话，挖掘**重复行为**——反复执行的命令/工具序列
（如 build→test 流程）和反复出现的纠正反馈（中英文）——再调用本机已安装的
`claude` CLI 把每个模式写成一份 Claude Code skill（SKILL.md）：

```bash
npm run skills -- /path/to/project              # 挖掘 + 生成
npm run skills -- /path/to/project --report-only # 只输出候选报告，不调用 claude
```

可选参数：`--min-support N`（序列模式最少出现在 N 个会话，默认 3）、
`--max-skills N`（最多生成 N 个，默认 10）、`--model name`（默认 sonnet）。

结果写入审查目录 `~/.open-agent-memory/skills/<project-slug>/`（含 `report.md` /
`report.json` 和每个 skill 的 `SKILL.md`），**不会**直接写入目标项目——人工审查后
自行拷贝到项目的 `.claude/skills/`。未安装 `claude` CLI 时自动降级为仅输出报告。

## Web UI

```bash
# 先启动后端 API
npm run serve

# 另开终端启动前端（自动代理 /api 到 8787）
cd web
npm install
npm run dev   # http://localhost:5173
```

三列布局：左侧按来源和项目过滤，中间实时搜索会话列表（防抖 200ms），右侧查看完整消息记录。

## 开发与扩展

添加新适配器的步骤（详见 [AGENTS.md](AGENTS.md)）：

1. **先确认真实数据格式** — 不要凭记忆猜测，实际检查文件：`head -3 <file> | jq .` 或 `sqlite3 <file> .tables`
2. 在 `adapters/<tool>.ts` 中实现 `Adapter` 接口（`discover()` + `parseFile()`）
3. 在 `model.ts` 的 `Source` 联合类型中添加工具名称
4. 在 `cli.ts` 的 `adapters[]` 数组中注册新适配器
5. 用真实数据运行 `npm run sync` 和 `npm run search` 验证效果

**不变式（不可简化掉的设计原则）：**
- 适配器对源文件严格只读
- `message.raw` 保留原始内容，格式变更后可重新解析
- 源文件消失时标记 `deleted`，永不 `DELETE`
- 同步幂等：同一数据重复运行不产生重复行

---

<a id="english"></a>

[中文](#openagentmemory) | English

# OpenAgentMemory

> Local-first archive and full-text search for AI coding-tool sessions

Normalizes session logs from Claude Code, Codex, OpenCode, and more into a single local SQLite database with FTS5 full-text search. All data stays on your machine. Source files are never modified. Sessions outlive the tools that created them.

> **The ultimate goal: connect the history across every vendor's Agent, so the AI's memory truly belongs to you.** Switch tools without losing your context.

## Features

- **Multi-tool archive** — Claude Code, Codex, OpenCode supported; Gemini and Trae planned
- **Incremental & idempotent sync** — JSONL files are read from a byte offset; re-running sync never duplicates data
- **Strictly read-only** — adapters never write to or move source files, safe to run alongside live tools
- **Archive-first** — when a source file disappears, its sessions are marked `deleted` and kept forever
- **FTS5 full-text search** — matches highlighted with `«keyword»`
- **Web UI** — React three-column layout: filters | session list | message detail
- **REST API** — Hono-powered, with pagination, source filtering, and full-text search

## Architecture

```
adapters/          ← one per tool: discover() + parseFile() → normalized records
    │
    ▼
db.ts              ← ingest engine: incremental sync, dedup, FTS5 index
    │
    ▼
SQLite archive     ← ~/.open-agent-memory/archive.db
    │
   ┌┴──────────────┐
   ▼               ▼
cli.ts          server.ts    ← REST API (Hono, port 8787)
                mcp.ts       ← local MCP memory service (stdio, read-only)
                   │
                   ▼
               web/           ← React + Vite frontend (port 5173)
```

**Key files:**

| File | Purpose |
|------|---------|
| `model.ts` | Shared `Session` / `Message` types |
| `adapters/adapter.ts` | `Adapter` interface every tool implements |
| `adapters/claude-code.ts` | Claude Code adapter (reference implementation) |
| `adapters/codex.ts` | Codex adapter |
| `adapters/opencode.ts` | OpenCode adapter (SQLite source) |
| `db.ts` | Schema + `sync()` ingest engine |
| `cli.ts` | CLI entry point; register new adapters here |
| `server.ts` | REST API server |
| `paths.ts` | Data home resolution + auto-migration from legacy `~/.ai-sessions/` |
| `mine.ts` | Pattern mining: repeated command sequences and corrections (`skills`) |
| `skillgen.ts` | Turns mined patterns into SKILL.md via the local `claude` CLI |

## Supported AI Tools

| Tool | Status | Data path | Format |
|------|--------|-----------|--------|
| Claude Code | ✅ | `~/.claude/projects/**/*.jsonl` | JSONL |
| Codex | ✅ | `~/.codex/sessions/**/*.jsonl`<br>`~/.codex/archived_sessions/` | JSONL |
| OpenCode | ✅ | `~/.local/share/opencode/opencode.db` | SQLite |
| Gemini CLI | 🔜 planned | — | — |
| Trae | 🔜 planned | — | — |

## Quick Start

```bash
git clone <repo-url> OpenAgentMemory
cd OpenAgentMemory
npm install

npm run sync           # discover and archive sessions from all installed tools
npm run list           # show 30 most recent sessions
npm run search "query" # full-text search
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run sync` | Discover and incrementally archive all tool sessions |
| `npm run list` | List the 30 most recent sessions (source, msg count, updated, title) |
| `npm run search "<q>"` | FTS5 full-text search, top 20 hits |
| `npm run skills -- [path]` | Mine repeated behaviors from a project's sessions and generate skills |
| `npm run serve` | Start the REST API server (port 8787) |
| `npm run mcp` | Start the local MCP memory service (stdio, read-only) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run the CLI directly via `tsx` (no build step) |

Archive database: `~/.open-agent-memory/archive.db` (auto-migrated from the
legacy `~/.ai-sessions/` on first run)

The MCP service exposes read-only query tools only: search, list sessions, get a
session, and get messages. It does not run sync, execute SQL, read source files,
or return message `raw` source records.

## Generating skills (experimental)

Analyze all archived sessions of a project/folder, mine **repeated behaviors** —
recurring command/tool sequences (e.g. build→test flows) and recurring user
corrections (English + Chinese) — then ask the locally installed `claude` CLI to
write each pattern up as a Claude Code skill (SKILL.md):

```bash
npm run skills -- /path/to/project               # mine + generate
npm run skills -- /path/to/project --report-only # candidates report only, no claude calls
```

Options: `--min-support N` (a sequence must appear in ≥ N sessions, default 3),
`--max-skills N` (cap, default 10), `--model name` (default sonnet).

Output goes to a review directory, `~/.open-agent-memory/skills/<project-slug>/`
(`report.md` / `report.json` plus one `SKILL.md` per pattern) — never into the
target project; review and copy into the project's `.claude/skills/` yourself.
Without the `claude` CLI installed, the command degrades to report-only.

## Web UI

```bash
# Start the backend first
npm run serve

# In another terminal
cd web
npm install
npm run dev   # http://localhost:5173
```

Three-column layout: filter by source and project path on the left, real-time debounced search in the middle, full message thread on the right.

## Development & Extending

To add a new adapter (see [AGENTS.md](AGENTS.md) for full details):

1. **Inspect the real data format first** — don't guess; check an actual install: `head -3 <file> | jq .` or `sqlite3 <file> .tables`
2. Create `adapters/<tool>.ts` implementing the `Adapter` interface (`discover()` + `parseFile()`)
3. Add the tool name to the `Source` union in `model.ts`
4. Register an instance in the `adapters[]` array in `cli.ts`
5. Test with real data: `npm run sync` then `npm run search` should return sensible hits

**Non-negotiable invariants:**
- Adapters are strictly read-only against source files
- `message.raw` stores the verbatim source — re-derive everything from it if a format changes
- Source deletion = mark `deleted`, never `DELETE FROM sessions`
- Sync is idempotent: the same data can be ingested multiple times without creating duplicates
