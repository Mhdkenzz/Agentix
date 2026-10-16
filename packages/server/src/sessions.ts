// Agentix — session manager (spawn, steer, stop, restart)
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Agent, AgentEvent, Role } from '../../shared/src/types.ts';
import { NAMES, AVATAR_NAMES } from '../../shared/src/types.ts';
import { getAdapter } from './adapters/index.ts';
import { store } from './store.ts';
import { EventBus } from './bus.ts';

function randomId(): string {
  return 'a_' + randomUUID().slice(0, 6);
}

function randomName(): string {
  return NAMES[Math.floor(Math.random() * NAMES.length)];
}

function randomAvatarId(): number {
  return Math.floor(Math.random() * 10);
}

function ensureCwd(cwd: string): string {
  if (!cwd || cwd === '.') {
    cwd = join(homedir(), '.agentix', 'workspace');
    if (!existsSync(cwd)) {
      mkdirSync(cwd, { recursive: true });
    }
  }
  return cwd;
}

// Track running agent processes for interrupt
interface RunningAgent {
  process: any;
  adapter: ReturnType<typeof getAdapter>;
}
const runningAgents = new Map<string, RunningAgent>();

// Team digest for coordinator/CEO updates
interface TeamDigestEntry {
  name: string;
  role: string;
  status: string;
  activity: string;
  lastOutputs: string[];
}

interface TeamDigest {
  [agentId: string]: TeamDigestEntry;
}

let teamDigest: TeamDigest = {};

function updateDigest(agentId: string): void {
  const agent = store.getAgent(agentId);
  if (!agent) {
    delete teamDigest[agentId];
    return;
  }
  const events = store.getAgentEvents(agentId).filter(e => e.type === 'output');
  const lastOutputs = events.slice(-3).map(e => (e.text || '').split('\n').slice(0, 3).join('\n'));
  teamDigest[agentId] = {
    name: agent.name,
    role: agent.role,
    status: agent.status,
    activity: agent.activity,
    lastOutputs,
  };
}

function buildDigestText(): string {
  const entries = Object.values(teamDigest);
  if (entries.length === 0) return '(no agents)';
  return entries.map(e => `${e.name} (${e.role}): ${e.status} — ${e.activity}`).join('\n');
}

function notifyCoordinator(event: AgentEvent, extraText?: string): void {
  // Find coordinator agents
  const agents = store.getAgents();
  const coordinators = agents.filter(a => a.role === 'coordinator' || a.role === 'ceo');
  const digest = buildDigestText();
  const text = extraText ? `[AGENTIX UPDATE]\n${extraText}\n\nTeam:\n${digest}` : `[AGENTIX UPDATE]\n${digest}`;

  for (const coord of coordinators) {
    store.appendEvent({ type: 'message', from: 'system', text }, coord.id);
  }
}

export class SessionManager {
  private bus: EventBus;
  constructor(bus: EventBus) {
    this.bus = bus;
  }

  createAgent(kind: string, opts: {
    name?: string;
    role: Role;
    avatarId?: number | 'random';
    cwd?: string;
    prompt?: string;
  }): Agent {
    const { name, role, avatarId, cwd, prompt } = opts;
    const agentId = randomId();
    const agentName = name || randomName();
    const avatar = avatarId === 'random' ? randomAvatarId() : (avatarId ?? 0);
    const resolvedCwd = ensureCwd(cwd || '.');

    const agent: Agent = {
      id: agentId,
      name: agentName,
      kind: kind as any,
      role,
      avatarId: avatar,
      cwd: resolvedCwd,
      status: 'starting',
      activity: 'starting...',
      createdAt: Date.now(),
    };

    store.createAgent(agent);
    const createdEvent = store.appendEvent({ type: 'agent.created', from: 'user', text: `Agent ${agentName} created (${kind}, ${role})` }, agentId);
    this.bus.publish(createdEvent);

    // Enforce one coordinator and one CEO
    if (role === 'coordinator') {
      const existing = store.getAgents().find(a => a.role === 'coordinator' && a.id !== agentId);
      if (existing) {
        existing.role = 'worker';
        store.updateAgent(existing);
      }
    }
    if (role === 'ceo') {
      const existing = store.getAgents().find(a => a.role === 'ceo' && a.id !== agentId);
      if (existing) {
        existing.role = 'worker';
        store.updateAgent(existing);
      }
    }

    // If prompt provided, start the agent immediately
    if (prompt) {
      this.startAgent(agent, prompt);
    }

    return agent;
  }

  private startAgent(agent: Agent, prompt: string): void {
    const adapter = getAdapter(agent.kind);
    if (!adapter) {
      store.appendEvent({ type: 'error', text: `Unknown adapter: ${agent.kind}` }, agent.id);
      return;
    }

    agent.status = 'thinking';
    agent.activity = 'thinking...';
    store.updateAgent(agent);
    store.appendEvent({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: 'thinking...' } }, agent.id);

    const ctx = {
      agent,
      emit: (e: Omit<AgentEvent, 'id' | 'ts' | 'agentId'>) => {
        const full = store.appendEvent(e, agent.id);
        this.bus.publish(full);
        updateDigest(agent.id);

        // Update agent status/activity from status events
        if (e.type === 'status' && e.data && typeof e.data === 'object') {
          const s = (e.data as any).status;
          const a = (e.data as any).activity;
          if (s) agent.status = s as Status;
          if (a) agent.activity = a;
          store.updateAgent(agent);
        }

        // Notify coordinator on important events
        if (e.type === 'status' && e.data && typeof e.data === 'object' && 'status' in e.data) {
          const status = (e.data as any).status as string;
          if (status === 'idle' || status === 'error' || status === 'stopped') {
            notifyCoordinator(full, `Agent ${agent.name} finished: ${status}`);
          }
        }
        if (e.type === 'error') {
          notifyCoordinator(full, `Agent ${agent.name} error: ${e.text}`);
        }
      },
      setNativeSessionId: (id: string) => {
        agent.nativeSessionId = id;
        store.updateAgent(agent);
      },
    };

    // Start the adapter's send in background
    (async () => {
      try {
        await adapter.send(ctx, prompt);
      } catch (err: any) {
        store.appendEvent({ type: 'error', text: err?.message || String(err) }, agent.id);
        agent.status = 'error';
        agent.activity = `error: ${err?.message || 'unknown'}`;
        store.updateAgent(agent);
        notifyCoordinator(store.appendEvent({ type: 'error', text: `Agent ${agent.name} crashed: ${err?.message}` }, agent.id), `Agent ${agent.name} crashed`);
      }
    })();
  }

  async steerAgent(agentId: string, text: string, from?: string): Promise<AgentEvent> {
    const agent = store.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const event = store.appendEvent({ type: 'steer', from: from || 'user', text }, agentId);
    this.bus.publish(event);

    // Notify coordinator immediately
    notifyCoordinator(event, `Steered ${agent.name}: "${text.slice(0, 80)}"`);

    // If agent is working, interrupt first
    if (agent.status === 'working' || agent.status === 'thinking') {
      await this.interruptAgent(agentId);
    }

    // Start new turn
    this.startAgent(agent, text);

    return event;
  }

  async interruptAgent(agentId: string): Promise<void> {
    const agent = store.getAgent(agentId);
    if (!agent) return;

    const running = runningAgents.get(agentId);
    if (running) {
      await running.adapter.interrupt({
        agent,
        emit: (e) => {
          const full = store.appendEvent(e, agent.id);
          this.bus.publish(full);
        },
        setNativeSessionId: () => {},
      });
      runningAgents.delete(agentId);
    }

    agent.status = 'stopped';
    agent.activity = 'interrupted';
    store.updateAgent(agent);
    store.appendEvent({ type: 'status', text: 'stopped', data: { status: 'stopped', activity: 'interrupted' } }, agentId);
    this.bus.publish(store.appendEvent({ type: 'agent.updated', text: `Agent ${agent.name} stopped` }, agentId));
  }

  removeAgent(agentId: string): void {
    const agent = store.getAgent(agentId);
    if (!agent) return;

    this.interruptAgent(agentId).catch(() => {});
    runningAgents.delete(agentId);

    store.removeAgent(agentId);
    store.appendEvent({ type: 'agent.removed', text: `Agent ${agent.name} removed` }, agentId);
    this.bus.publish(store.appendEvent({ type: 'agent.removed', text: `Agent ${agent.name} removed` }, agentId));
  }

  getAgents(): Agent[] {
    return store.getAgents();
  }

  getAgent(agentId: string): Agent | undefined {
    return store.getAgent(agentId);
  }

  getAgentEvents(agentId: string, after?: number): AgentEvent[] {
    return store.getAgentEvents(agentId, after);
  }

  getAllEvents(after?: number): AgentEvent[] {
    return store.getEvents(after);
  }
}
