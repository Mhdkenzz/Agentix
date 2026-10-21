// App state: agents, recent events per agent, selection and in-flight message arcs.
import { create } from 'zustand';
import type { Agent, AgentEvent, Task, Usage } from '../../shared/src/types.ts';
import type { ServerSettings, UsageTotal } from './api.ts';

const MAX_EVENTS_PER_AGENT = 400;
const ARC_MS = 2500;

export interface Arc { id: number; from: string; to: string; born: number }

interface State {
  agents: Record<string, Agent>;
  /** removed agents, whose history is kept (loaded by the History page) */
  archived: Record<string, Agent>;
  events: Record<string, AgentEvent[]>;
  lastEventId: number;
  connected: boolean;
  /** the server wants an API token (AGENTIX_TOKEN) and we do not have it */
  needsToken: boolean;
  selectedId?: string;
  arcs: Arc[];
  showNewAgent: boolean;
  server?: ServerSettings;
  /** the task board */
  tasks: Record<string, Task>;
  /** tokens and cost per agent: all time, and since local midnight */
  usage: Record<string, UsageTotal>;
  usageToday: Record<string, UsageTotal>;
  setTasks(list: Task[]): void;
  setUsage(total: UsageTotal[], today: UsageTotal[]): void;
  setServerSettings(s: ServerSettings): void;
  setAgents(list: Agent[]): void;
  setArchived(list: Agent[]): void;
  applyEvent(e: AgentEvent): void;
  setHistory(agentId: string, list: AgentEvent[]): void;
  setConnected(c: boolean): void;
  setNeedsToken(v: boolean): void;
  select(id?: string): void;
  setShowNewAgent(v: boolean): void;
  pruneArcs(now: number): void;
}

export const useStore = create<State>((set, get) => ({
  agents: {},
  archived: {},
  events: {},
  lastEventId: 0,
  connected: false,
  needsToken: false,
  arcs: [],
  showNewAgent: false,
  tasks: {},
  usage: {},
  usageToday: {},
  setServerSettings(server) { set({ server }); },
  setTasks(list) { set({ tasks: Object.fromEntries(list.map(t => [t.id, t])) }); },
  setUsage(total, today) {
    set({ usage: Object.fromEntries(total.map(u => [u.agentId, u])), usageToday: Object.fromEntries(today.map(u => [u.agentId, u])) });
  },

  setAgents(list) {
    set({ agents: Object.fromEntries(list.map(a => [a.id, a])) });
  },
  setArchived(list) {
    set({ archived: Object.fromEntries(list.filter(a => a.archivedAt).map(a => [a.id, a])) });
  },

  applyEvent(e) {
    const s = get();
    if (e.id && e.id <= s.lastEventId && s.events[e.agentId]?.some(x => x.id === e.id)) return; // replay duplicate
    const agents = { ...s.agents };
    let archived = s.archived;
    const current = agents[e.agentId];
    switch (e.type) {
      case 'agent.created':
      case 'agent.updated':
        if (e.data && typeof e.data === 'object') agents[e.agentId] = { ...current, ...(e.data as Agent) };
        break;
      case 'agent.removed':
        if (current) archived = { ...archived, [e.agentId]: { ...current, archivedAt: e.ts, status: 'stopped', activity: 'removed' } };
        delete agents[e.agentId];
        break;
      case 'status': {
        const d = (e.data ?? {}) as { status?: Agent['status']; activity?: string };
        if (current) agents[e.agentId] = { ...current, status: d.status ?? current.status, activity: d.activity ?? current.activity };
        break;
      }
    }
    let { tasks, usage, usageToday } = s;
    if (e.type === 'task' && e.data && typeof e.data === 'object') {
      const t = e.data as Task & { deleted?: boolean };
      tasks = { ...tasks };
      if (t.deleted) delete tasks[t.id]; else tasks[t.id] = t;
    }
    if (e.type === 'usage' && e.data && typeof e.data === 'object') {
      const add = (m: Record<string, UsageTotal>) => {
        const u = e.data as Usage;
        const p = m[e.agentId] ?? { agentId: e.agentId, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        return { ...m, [e.agentId]: { ...p, turns: p.turns + 1, input: p.input + (u.input ?? 0), output: p.output + (u.output ?? 0),
          cacheRead: (p.cacheRead ?? 0) + (u.cacheRead ?? 0), cacheWrite: (p.cacheWrite ?? 0) + (u.cacheWrite ?? 0), cost: (p.cost ?? 0) + (u.cost ?? 0) } };
      };
      usage = add(usage);
      usageToday = add(usageToday);
    }
    const list = (s.events[e.agentId] ?? []).concat(e);
    const events = { ...s.events, [e.agentId]: list.length > MAX_EVENTS_PER_AGENT ? list.slice(-MAX_EVENTS_PER_AGENT) : list };
    if (e.type === 'agent.removed') delete events[e.agentId];

    // Agent-to-agent traffic draws a paper plane between desks.
    let arcs = s.arcs;
    const from = e.from;
    if ((e.type === 'message' || e.type === 'steer') && from && from !== 'user' && from !== 'system' && agents[from] && from !== e.agentId) {
      arcs = arcs.concat({ id: e.id, from, to: e.agentId, born: performance.now() });
    }
    set({
      agents, archived, events, arcs, tasks, usage, usageToday,
      lastEventId: Math.max(s.lastEventId, e.id || 0),
      selectedId: e.type === 'agent.removed' && s.selectedId === e.agentId ? undefined : s.selectedId,
    });
  },

  setHistory(agentId, list) {
    const known = get().events[agentId] ?? [];
    const merged = new Map<number, AgentEvent>();
    for (const e of [...list, ...known]) merged.set(e.id, e);
    const sorted = [...merged.values()].sort((a, b) => a.id - b.id).slice(-MAX_EVENTS_PER_AGENT);
    set({ events: { ...get().events, [agentId]: sorted } });
  },

  setConnected(connected) { set({ connected }); },
  setNeedsToken(needsToken) { set({ needsToken }); },
  select(selectedId) { set({ selectedId }); },
  setShowNewAgent(showNewAgent) { set({ showNewAgent }); },
  pruneArcs(now) {
    const arcs = get().arcs;
    if (arcs.some(a => now - a.born > ARC_MS)) set({ arcs: arcs.filter(a => now - a.born <= ARC_MS) });
  },
}));

export const ARC_DURATION_MS = ARC_MS;

/** Events since the agent's last "Clear" (a session event with data.clear), the marker included. */
export function sinceClear(list: AgentEvent[] | undefined): AgentEvent[] {
  if (!list) return [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.type === 'session' && (e.data as { clear?: boolean } | undefined)?.clear) return list.slice(i);
  }
  return list;
}

/** 12345 -> "12.3k" */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function fmtCost(usd: number | undefined): string {
  if (!usd) return '';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
