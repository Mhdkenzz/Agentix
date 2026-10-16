// REST + SSE client for the Agentix server. In dev, Vite proxies /api to the server.
import type { Agent, AgentEvent, Role } from '../../shared/src/types.ts';

export interface AdapterInfo { kind: string; installed: boolean; version?: string }

export class ApiError extends Error {
  status: number;
  data?: any;
  constructor(status: number, message: string, data?: any) { super(message); this.status = status; this.data = data; }
}

async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `${method} ${path} failed (${res.status})`, data.data);
  return data as T;
}

export interface NewAgent {
  kind: string;
  name?: string;
  role?: Role;
  avatarId?: number | 'random';
  cwd?: string;
  prompt?: string;
  replace?: boolean;
}

export type CoordinatorMode = 'human' | 'agent' | 'both';
export interface ServerSettings {
  coordinatorMode: CoordinatorMode;
  cliPaths: Record<string, string>;
  defaultKind: string;
  defaultCwd: string;
  sharedContext: boolean;
  contextPaths: string[];
  setupDone: boolean;
}

export interface Note { id: string; ts: number; from: string; text: string }
export interface ContextHit { source: 'note' | 'output' | 'file'; title: string; text: string; score: number; ts?: number; agentId?: string; path?: string }
export interface ContextInfo { brief: string; notes: Note[]; contextPaths: string[]; sharedContext: boolean; dir: string }
export interface FoundCli { kind: string; name: string; path: string; version: string; runs: boolean; on_path: boolean; all_paths: string[]; supported: boolean }
export interface ScanResult { scanner: 'python' | 'node'; platform: string; found: FoundCli[] }

export const api = {
  settings: () => call<{ settings: ServerSettings }>('/api/settings').then(r => r.settings),
  saveSettings: (patch: Partial<ServerSettings>) => call<{ settings: ServerSettings }>('/api/settings', 'PUT', patch).then(r => r.settings),
  askCoordinator: (text: string, about?: string) => call('/api/coordinator/ask', 'POST', { text, about }),
  adapters: () => call<{ adapters: AdapterInfo[] }>('/api/adapters').then(r => r.adapters),
  agents: () => call<{ agents: Agent[] }>('/api/agents').then(r => r.agents),
  snapshot: () => call<{ agents: Agent[]; lastEventId: number }>('/api/agents'),
  create: (a: NewAgent) => call<{ agent: Agent }>('/api/agents', 'POST', a).then(r => r.agent),
  update: (id: string, patch: Partial<Agent> & { replace?: boolean }) =>
    call<{ agent: Agent }>(`/api/agents/${id}`, 'PATCH', patch).then(r => r.agent),
  remove: (id: string) => call(`/api/agents/${id}`, 'DELETE'),
  /** live and removed agents (removed ones have archivedAt) */
  allAgents: () => call<{ agents: Agent[]; historyDir: string }>('/api/agents?archived=1'),
  /** fresh native session; clear also hides earlier events in the dashboard */
  newSession: (id: string, clear: boolean) => call(`/api/agents/${id}/session`, 'POST', { clear }),
  context: () => call<ContextInfo>('/api/context'),
  saveBrief: (text: string) => call<{ brief: string }>('/api/context/brief', 'PUT', { text }).then(r => r.brief),
  addNote: (text: string) => call<{ note: Note | null }>('/api/context/notes', 'POST', { text }).then(r => r.note),
  deleteNote: (id: string) => call(`/api/context/notes/${encodeURIComponent(id)}`, 'DELETE'),
  searchContext: (q: string) => call<{ hits: ContextHit[] }>(`/api/context/search?q=${encodeURIComponent(q)}&limit=20`).then(r => r.hits),
  scan: () => call<ScanResult>('/api/setup/scan'),
  steer: (id: string, text: string) => call(`/api/agents/${id}/steer`, 'POST', { text, from: 'user' }),
  interrupt: (id: string) => call(`/api/agents/${id}/interrupt`, 'POST'),
  events: (id: string, after = 0) =>
    call<{ events: AgentEvent[] }>(`/api/agents/${id}/events?after=${after}`).then(r => r.events),
};

const EVENT_TYPES = ['agent.created', 'agent.updated', 'agent.removed', 'output', 'tool', 'thinking', 'status', 'steer', 'message', 'session', 'error'];

/**
 * One EventSource for everything. The browser reconnects on its own and sends
 * Last-Event-ID, so the server replays whatever we missed.
 */
export function connectStream(after: number, onEvent: (e: AgentEvent) => void, onState: (connected: boolean) => void): () => void {
  const es = new EventSource(`/api/stream?after=${after}`);
  const handler = (m: MessageEvent) => {
    try { onEvent(JSON.parse(m.data)); } catch { /* ignore malformed */ }
  };
  for (const t of EVENT_TYPES) es.addEventListener(t, handler as EventListener);
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
