// App state: agents, recent events per agent, selection and in-flight message arcs.
import { create } from 'zustand';
import type { Agent, AgentEvent } from '../../shared/src/types.ts';
import type { ServerSettings } from './api.ts';

const MAX_EVENTS_PER_AGENT = 400;
const ARC_MS = 2500;

export interface Arc { id: number; from: string; to: string; born: number }

interface State {
  agents: Record<string, Agent>;
  events: Record<string, AgentEvent[]>;
  lastEventId: number;
  connected: boolean;
  selectedId?: string;
  arcs: Arc[];
  showNewAgent: boolean;
  server?: ServerSettings;
  setServerSettings(s: ServerSettings): void;
  setAgents(list: Agent[]): void;
  applyEvent(e: AgentEvent): void;
  setHistory(agentId: string, list: AgentEvent[]): void;
  setConnected(c: boolean): void;
  select(id?: string): void;
  setShowNewAgent(v: boolean): void;
  pruneArcs(now: number): void;
}

export const useStore = create<State>((set, get) => ({
  agents: {},
  events: {},
  lastEventId: 0,
  connected: false,
  arcs: [],
  showNewAgent: false,
  setServerSettings(server) { set({ server }); },

  setAgents(list) {
    set({ agents: Object.fromEntries(list.map(a => [a.id, a])) });
  },

  applyEvent(e) {
    const s = get();
    if (e.id && e.id <= s.lastEventId && s.events[e.agentId]?.some(x => x.id === e.id)) return; // replay duplicate
    const agents = { ...s.agents };
    const current = agents[e.agentId];
    switch (e.type) {
      case 'agent.created':
      case 'agent.updated':
        if (e.data && typeof e.data === 'object') agents[e.agentId] = { ...current, ...(e.data as Agent) };
        break;
      case 'agent.removed':
        delete agents[e.agentId];
        break;
      case 'status': {
        const d = (e.data ?? {}) as { status?: Agent['status']; activity?: string };
        if (current) agents[e.agentId] = { ...current, status: d.status ?? current.status, activity: d.activity ?? current.activity };
        break;
      }
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
      agents, events, arcs,
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
  select(selectedId) { set({ selectedId }); },
  setShowNewAgent(showNewAgent) { set({ showNewAgent }); },
  pruneArcs(now) {
    const arcs = get().arcs;
    if (arcs.some(a => now - a.born > ARC_MS)) set({ arcs: arcs.filter(a => now - a.born <= ARC_MS) });
  },
}));

export const ARC_DURATION_MS = ARC_MS;
