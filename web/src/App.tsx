import { useEffect, useMemo, useState } from "react";
import {
  api,
  type Message,
  type SearchHit,
  type Session,
  type Source,
} from "./api.js";

const ALL_SOURCES: Source[] = [
  "claude-code",
  "codex",
  "gemini",
  "opencode",
  "trae",
];

export function App() {
  // --- Filters (left column) ---
  const [enabledSources, setEnabledSources] = useState<Set<Source>>(
    new Set(ALL_SOURCES)
  );
  const [projectQuery, setProjectQuery] = useState("");
  const [hideDeleted, setHideDeleted] = useState(false);

  // --- Search (middle column) ---
  const [searchQuery, setSearchQuery] = useState("");

  // --- Data ---
  const [sessions, setSessions] = useState<Session[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [counts, setCounts] = useState<Record<Source, number>>(
    Object.fromEntries(ALL_SOURCES.map((s) => [s, 0])) as Record<Source, number>
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  // Per-source counts for the filter sidebar (one query each, parallel).
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      ALL_SOURCES.map(async (s) => {
        const body = await api.listSessions({ source: s, limit: 1 });
        return [s, body.total] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      setCounts(Object.fromEntries(entries) as Record<Source, number>);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch session list whenever filters change.
  useEffect(() => {
    let cancelled = false;
    const all = enabledSources.size === ALL_SOURCES.length;
    // The API only takes one source at a time; fan out when needed.
    const sourceList: (Source | undefined)[] = all ? [undefined] : [...enabledSources];
    Promise.all(
      sourceList.map(async (s) => {
        const body = await api.listSessions({
          source: s,
          q: projectQuery || undefined,
          status: hideDeleted ? "present" : undefined,
          limit: 100,
        });
        return body.items;
      })
    ).then((lists) => {
      if (cancelled) return;
      const merged = lists.flat();
      merged.sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
      );
      setSessions(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [enabledSources, projectQuery, hideDeleted]);

  // Debounced search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const handle = setTimeout(async () => {
      const body = await api.search({ q, limit: 30 });
      setHits(body.items);
    }, 200);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  // Load messages for the selected session.
  useEffect(() => {
    if (!selectedId) {
      setSelectedSession(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    Promise.all([
      api.getSession(selectedId),
      api.listMessages(selectedId, { limit: 500 }),
    ])
      .then(([session, msgs]) => {
        if (cancelled) return;
        setSelectedSession(session);
        setMessages(msgs.items);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedSession(null);
        setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const visibleSessions = useMemo(() => {
    return hideDeleted
      ? sessions.filter((s) => s.sourceStatus !== "deleted")
      : sessions;
  }, [sessions, hideDeleted]);

  const inSearchMode = searchQuery.trim().length > 0;

  return (
    <div className="app">
      {/* === Left: filters =============================================== */}
      <aside className="col">
        <div className="col-header">
          <h2>Sources</h2>
        </div>
        <div className="col-body">
          <div className="filter-group">
            {ALL_SOURCES.map((s) => (
              <label key={s} className="row">
                <input
                  type="checkbox"
                  checked={enabledSources.has(s)}
                  onChange={(e) => {
                    setEnabledSources((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s);
                      else next.delete(s);
                      return next;
                    });
                  }}
                />
                <span>{s}</span>
                <span className="count">{counts[s] ?? 0}</span>
              </label>
            ))}
          </div>

          <div className="filter-group">
            <h2 style={{ margin: "0 0 8px", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Project
            </h2>
            <input
              type="search"
              placeholder="filter by path or title"
              value={projectQuery}
              onChange={(e) => setProjectQuery(e.target.value)}
            />
          </div>

          <div className="filter-group">
            <label className="row">
              <input
                type="checkbox"
                checked={hideDeleted}
                onChange={(e) => setHideDeleted(e.target.checked)}
              />
              <span>Hide deleted sources</span>
            </label>
          </div>
        </div>
      </aside>

      {/* === Middle: session list / search hits ========================== */}
      <section className="col">
        <div className="col-header">
          <h2>{inSearchMode ? "Search" : "Sessions"}</h2>
          <input
            type="search"
            placeholder="full-text search messages…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="col-body">
          {inSearchMode
            ? hits.map((h) => (
                <div
                  key={h.message.id}
                  className={`session hit ${
                    selectedId === h.session.id ? "active" : ""
                  }`}
                  onClick={() => setSelectedId(h.session.id)}
                >
                  <div className="title">
                    {h.session.title ?? "(untitled)"}
                  </div>
                  <div className="meta">
                    <span className="source">{h.session.source}</span>
                    <span>{h.message.role}</span>
                    <span>#{h.message.seq}</span>
                  </div>
                  <div
                    className="snippet"
                    dangerouslySetInnerHTML={{
                      __html: renderSnippet(h.snippet),
                    }}
                  />
                </div>
              ))
            : visibleSessions.map((s) => (
                <div
                  key={s.id}
                  className={`session ${selectedId === s.id ? "active" : ""}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <div className="title">
                    {s.title ?? "(untitled)"}
                    {s.sourceStatus === "deleted" && (
                      <span className="deleted"> · deleted</span>
                    )}
                  </div>
                  <div className="meta">
                    <span className="source">{s.source}</span>
                    <span>{s.messageCount} msgs</span>
                    <span>{formatDate(s.updatedAt)}</span>
                  </div>
                  {s.projectPath && (
                    <div className="project" title={s.projectPath}>
                      {s.projectPath}
                    </div>
                  )}
                </div>
              ))}

          {!inSearchMode && visibleSessions.length === 0 && (
            <div style={{ padding: 20, color: "var(--muted)" }}>
              No sessions yet. Run <code>npm run sync</code>.
            </div>
          )}
          {inSearchMode && hits.length === 0 && (
            <div style={{ padding: 20, color: "var(--muted)" }}>
              No matches.
            </div>
          )}
        </div>
      </section>

      {/* === Right: message timeline ===================================== */}
      <main className="col">
        {selectedSession ? (
          <>
            <div className="timeline-header">
              <h1>{selectedSession.title ?? "(untitled)"}</h1>
              <div className="meta">
                <span>{selectedSession.source}</span>
                {selectedSession.model && <span>{selectedSession.model}</span>}
                <span>{selectedSession.messageCount} messages</span>
                <span>
                  in {selectedSession.totalInputTokens.toLocaleString()} / out{" "}
                  {selectedSession.totalOutputTokens.toLocaleString()} tok
                </span>
                {selectedSession.projectPath && (
                  <span title={selectedSession.projectPath}>
                    {selectedSession.projectPath}
                  </span>
                )}
                {selectedSession.sourceStatus === "deleted" && (
                  <span className="deleted">source deleted</span>
                )}
              </div>
            </div>
            <div className="timeline">
              {loadingMessages && messages.length === 0 && (
                <div className="empty">loading…</div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  <div className="head">
                    <span className="role">{m.role}</span>
                    {m.model && <span>{m.model}</span>}
                    {m.timestamp && <span>{formatTime(m.timestamp)}</span>}
                    {(m.inputTokens || m.outputTokens) && (
                      <span>
                        {m.inputTokens ?? 0} ↦ {m.outputTokens ?? 0}
                      </span>
                    )}
                  </div>
                  <div className="content">{m.content}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            Pick a session on the left to see its timeline.
          </div>
        )}
      </main>
    </div>
  );
}

// FTS5 returns plain text with `«…»` markers; turn those into <mark>.
function renderSnippet(raw: string): string {
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/«/g, "<mark>")
    .replace(/»/g, "</mark>");
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function formatTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 19);
}
