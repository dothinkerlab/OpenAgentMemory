// Typed fetch wrappers over the Hono server. Response shapes are imported
// directly from server.ts so the frontend can't drift from the backend.
//
// Vite proxies /api → http://localhost:8787 (see vite.config.ts).

import type { Source, Session, Message } from "../../model.js";
import type {
  SessionListResponse,
  MessageListResponse,
  SearchResponse,
} from "../../server.js";

const BASE = "/api";

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return (await res.json()) as T;
}

export const api = {
  listSessions(opts: {
    source?: Source;
    status?: "present" | "deleted";
    q?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    return get<SessionListResponse>(`/sessions${qs(opts)}`);
  },
  getSession(id: string) {
    return get<Session>(`/sessions/${encodeURIComponent(id)}`);
  },
  listMessages(id: string, opts: { limit?: number; offset?: number } = {}) {
    return get<MessageListResponse>(
      `/sessions/${encodeURIComponent(id)}/messages${qs(opts)}`
    );
  },
  search(opts: { q: string; source?: Source; limit?: number }) {
    return get<SearchResponse>(`/search${qs(opts)}`);
  },
};

export type { Session, Message, Source } from "../../model.js";
export type {
  SessionListResponse,
  MessageListResponse,
  SearchResponse,
  SearchHit,
} from "../../server.js";
