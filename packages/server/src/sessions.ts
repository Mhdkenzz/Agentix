// Agentix — session manager (spawn, steer, stop, restart) and coordinator updates
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Agent, AgentEvent, Role, Status } from '../../shared/src/types.ts';
import { NAMES } from '../../shared/src/types.ts';
import { getAdapter } from './adapters/index.ts';
import { KILL_GRACE_MS, oneLine } from './adapters/proc.ts';
import { store, AGENTIX_HOME } from './store.ts';
import { EventBus } from './bus.ts';
import { getSettings } from './settings.ts';
import { parseCommands, COORDINATOR_INSTRUCTIONS, CEO_INSTRUCTIONS, type Command } from './commands.ts';

const ROLES: Role[] = ['ceo', 'coordinator', 'worker'];
const BUSY: Status[] = ['starting', 'thinking', 'working'];

/** How long to batch coordinator updates before sending them as one turn. */
const UPDATE_DELAY_MS = Number(process.env.AGENTIX_UPDATE_DELAY_MS) || 5000;

export class HttpError extends Error {
  status: number;
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

type NewEvent = Omit<AgentEvent, 'id' | 'ts' | 'agentId'>;

interface RunningTurn {
  controller: AbortController;
  done: Promise<void>;
}

export interface CreateOptions {
  name?: string;
  role?: Role;
  avatarId?: number | 'random';
  cwd?: string;
  prompt?: string;
  /** demote an existing coordinator/CEO instead of failing with 409 */
  replace?: boolean;
  /** who asked: 'user' or the id of the agent (coordinator) that spawned it */
  from?: string;
}

/** A random name nobody in the office has yet (falls back to Name-2, Name-3, ... when all are taken). */
function pickName(): string {
  const taken = new Set(store.getAgents().map(a => a.name));
  const free = NAMES.filter(n => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  const base = NAMES[Math.floor(Math.random() * NAMES.length)];
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export class SessionManager {
  private bus: EventBus;
  private running = new Map<string, RunningTurn>();
  private pendingUpdates: string[] = [];
  private updateTimer: NodeJS.Timeout | undefined;
  /** messages waiting for an agent to finish its current turn (CEO <- coordinator) */
  private inbox = new Map<string, string[]>();
  /** role whose instructions each agent has already been given in its current session */
  private briefed = new Map<string, Role>();

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  // ---------- events ----------

  /** Persist an event and fan it out to SSE subscribers. */
  emit(agentId: string, e: NewEvent): AgentEvent {
    const full = store.appendEvent(e, agentId);
    this.bus.publish(full);
    return full;
  }

  private setStatus(agentId: string, status: Status, activity: string): void {
    const current = store.getAgent(agentId);
    if (!current || (current.status === status && current.activity === activity)) return;
    store.setStatus(agentId, status, activity);
    this.emit(agentId, { type: 'status', text: status, data: { status, activity } });
  }

  // ---------- agents ----------

  getAgents(): Agent[] { return store.getAgents(); }
  getAgent(id: string): Agent | undefined { return store.getAgent(id); }
  getAgentEvents(id: string, after?: number, limit?: number): AgentEvent[] { return store.getAgentEvents(id, after, limit); }
  isRunning(id: string): boolean { return this.running.has(id); }

  private requireAgent(id: string): Agent {
    const agent = store.getAgent(id);
    if (!agent) throw new HttpError(404, `Agent ${id} not found`);
    return agent;
  }

  /** Only one coordinator and one CEO: fail with 409, or demote the old one when `replace`. */
  private claimRole(role: Role, agentId: string, replace?: boolean): void {
    if (role === 'worker') return;
    const existing = store.getAgents().find(a => a.role === role && a.id !== agentId);
    if (!existing) return;
    if (!replace) {
      throw new HttpError(409, `${existing.name} (${existing.id}) is already the ${role}; pass replace to demote it`, { existing });
    }
    existing.role = 'worker';
    store.updateAgent(existing);
    this.emit(existing.id, { type: 'agent.updated', text: `${existing.name} demoted to worker`, data: existing });
  }

  createAgent(kind: string, opts: CreateOptions = {}): Agent {
    if (!getAdapter(kind)) throw new HttpError(400, `Unknown agent kind: ${kind}`);
    const role = opts.role ?? 'worker';
    if (!ROLES.includes(role)) throw new HttpError(400, `Unknown role: ${role}`);

    let avatarId: number;
    if (opts.avatarId === undefined || opts.avatarId === 'random') {
      avatarId = Math.floor(Math.random() * 10);
    } else {
      avatarId = Number(opts.avatarId);
      if (!Number.isInteger(avatarId) || avatarId < 0 || avatarId > 9) throw new HttpError(400, 'avatarId must be 0-9 or "random"');
    }

    let cwd = opts.cwd && opts.cwd !== '.' ? opts.cwd : join(AGENTIX_HOME, 'workspace');
    if (!isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path');
    mkdirSync(cwd, { recursive: true });

    const id = 'a_' + randomUUID().slice(0, 6);
    this.claimRole(role, id, opts.replace);

    const agent: Agent = {
      id,
      name: opts.name || pickName(),
      kind: kind as Agent['kind'],
      role,
      avatarId,
      cwd,
      status: 'idle',
      activity: 'idle',
      createdAt: Date.now(),
    };
    store.createAgent(agent);
    this.emit(id, { type: 'agent.created', from: opts.from ?? 'user', text: `Agent ${agent.name} created (${kind}, ${role})`, data: agent });

    if (opts.prompt) this.startTurn(id, opts.prompt);
    return store.getAgent(id)!;
  }

  updateAgent(id: string, patch: { name?: string; avatarId?: number; role?: Role; cwd?: string; replace?: boolean }): Agent {
    const agent = this.requireAgent(id);
    if (patch.role && patch.role !== agent.role) {
      if (!ROLES.includes(patch.role)) throw new HttpError(400, `Unknown role: ${patch.role}`);
      this.claimRole(patch.role, id, patch.replace);
      agent.role = patch.role;
    }
    if (patch.name) agent.name = patch.name;
    if (patch.avatarId !== undefined) {
      const n = Number(patch.avatarId);
      if (!Number.isInteger(n) || n < 0 || n > 9) throw new HttpError(400, 'avatarId must be 0-9');
      agent.avatarId = n;
    }
    if (patch.cwd) {
      if (!isAbsolute(patch.cwd)) throw new HttpError(400, 'cwd must be an absolute path');
      agent.cwd = patch.cwd;
    }
    store.updateAgent(agent);
    this.emit(id, { type: 'agent.updated', text: `Agent ${agent.name} updated`, data: agent });
    return agent;
  }

  async removeAgent(id: string): Promise<void> {
    const agent = this.requireAgent(id);
    await this.interruptAgent(id);
    store.removeAgent(id);
    this.inbox.delete(id);
    this.briefed.delete(id);
    this.emit(id, { type: 'agent.removed', text: `Agent ${agent.name} removed` });
  }

  // ---------- turns ----------

  private startTurn(agentId: string, prompt: string, from = 'user'): void {
    const agent = this.requireAgent(agentId);
    const adapter = getAdapter(agent.kind);
    if (!adapter) {
      this.emit(agentId, { type: 'error', text: `Unknown adapter: ${agent.kind}` });
      this.setStatus(agentId, 'error', `unknown adapter ${agent.kind}`);
      return;
    }

    // Two steers racing each other: never leave an older turn's process running untracked.
    this.running.get(agentId)?.controller.abort();

    const controller = new AbortController();
    const { signal } = controller;
    this.setStatus(agentId, 'thinking', 'thinking…');

    // Coordinator and CEO get their role instructions once per session (again after a role change).
    let instructions: string | undefined;
    if (agent.role !== 'worker' && (!agent.nativeSessionId || this.briefed.get(agentId) !== agent.role)) {
      instructions = agent.role === 'coordinator' ? COORDINATOR_INSTRUCTIONS : CEO_INSTRUCTIONS;
    }
    if (agent.role !== 'worker') this.briefed.set(agentId, agent.role);
    // The CEO always sees what the whole team is doing.
    if (agent.role === 'ceo') {
      const label = from === 'user' ? '[FROM KENZ]' : '';
      prompt = `[TEAM STATUS]\n${this.teamDigest(agentId)}\n\n${label ? label + '\n' : ''}${prompt}`;
    }

    const ctx = {
      agent,
      signal,
      instructions,
      emit: (e: NewEvent) => {
        if (signal.aborted) return; // late output from a turn that was replaced
        if (e.type === 'status') {
          const d = (e.data ?? {}) as { status?: Status; activity?: string };
          const status = d.status && BUSY.includes(d.status) ? d.status : 'working';
          this.setStatus(agentId, status, d.activity ?? e.text ?? status);
        } else {
          this.emit(agentId, e);
          if (e.type === 'output' && e.text && agent.role !== 'worker') this.runCommands(agentId, e.text);
        }
      },
      setNativeSessionId: (sid: string) => {
        if (agent.nativeSessionId === sid) return;
        agent.nativeSessionId = sid;
        store.setNativeSessionId(agentId, sid);
      },
    };

    const done = (async () => {
      let failure: string | undefined;
      try {
        await adapter.send(ctx, prompt);
      } catch (err: any) {
        failure = err?.message || String(err);
      }
      const current = this.running.get(agentId);
      if (current && current.controller !== controller) return; // superseded by a newer turn
      if (!current && signal.aborted) return; // interrupt timed out and already marked it stopped
      this.running.delete(agentId);
      if (!store.getAgent(agentId)) return; // removed meanwhile

      if (signal.aborted) {
        this.setStatus(agentId, 'stopped', 'interrupted');
      } else if (failure) {
        this.emit(agentId, { type: 'error', text: failure });
        this.setStatus(agentId, 'error', `error: ${oneLine(failure, 80)}`);
      } else {
        this.setStatus(agentId, 'idle', 'idle');
      }
      this.onTurnEnd(agentId, signal.aborted, failure);
    })();

    this.running.set(agentId, { controller, done });
  }

  /** Stop the current turn: abort -> SIGINT, then SIGTERM after the grace period. */
  async interruptAgent(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const turn = this.running.get(agentId);
    if (!turn) {
      if (BUSY.includes(agent.status)) this.setStatus(agentId, 'stopped', 'interrupted');
      return;
    }
    turn.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([turn.done, new Promise(r => { timer = setTimeout(r, KILL_GRACE_MS + 2000); })]);
    clearTimeout(timer);
    if (this.running.get(agentId) === turn) {
      // The process didn't exit in time; stop tracking it so the agent can be steered again.
      this.running.delete(agentId);
      this.emit(agentId, { type: 'error', text: 'turn did not stop within the grace period' });
      this.setStatus(agentId, 'stopped', 'interrupted');
    }
  }

  /** Interrupt if busy, then start a new turn (resuming the native session) with `text`. */
  async steerAgent(agentId: string, text: string, from = 'user'): Promise<AgentEvent> {
    if (!text) throw new HttpError(400, 'text is required');
    const agent = this.requireAgent(agentId);
    const event = this.emit(agentId, { type: 'steer', from, text });

    const coordinator = this.findRole('coordinator');
    if (agent.role === 'worker' && from !== coordinator?.id) {
      const who = from === 'user' ? 'kenz' : (store.getAgent(from)?.name ?? from);
      this.queueUpdate(`${who} steered ${agent.name} (${agent.id}): "${oneLine(text, 200)}"`);
    }

    if (this.running.has(agentId)) await this.interruptAgent(agentId);
    this.startTurn(agentId, text, from);
    return event;
  }

  /** Abort every running turn (server shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map(id => this.interruptAgent(id).catch(() => {})));
    if (this.updateTimer) clearTimeout(this.updateTimer);
  }

  // ---------- coordinator updates ----------

  private findRole(role: Role): Agent | undefined {
    return store.getAgents().find(a => a.role === role);
  }

  private onTurnEnd(agentId: string, aborted: boolean, failure?: string): void {
    const agent = store.getAgent(agentId);
    if (!agent) return;
    const waiting = this.inbox.get(agentId);
    if (waiting?.length && !aborted) {
      this.inbox.delete(agentId);
      this.startTurn(agentId, waiting.join('\n\n'), 'system');
    }
    if (agent.role === 'coordinator') {
      // Updates that arrived while the coordinator was busy go out now.
      if (this.pendingUpdates.length) this.scheduleFlush();
      return;
    }
    if (agent.role !== 'worker' || aborted) return; // steers/stops already produced their own update
    if (failure) {
      this.queueUpdate(`${agent.name} (${agent.id}) failed: ${oneLine(failure, 200)}`);
    } else {
      this.queueUpdate(`${agent.name} (${agent.id}) finished its turn`);
    }
  }

  private queueUpdate(line: string): void {
    if (!this.findRole('coordinator') || getSettings().coordinatorMode === 'human') return; // kenz coordinates
    this.pendingUpdates.push(line);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => this.flushUpdates(), UPDATE_DELAY_MS);
    this.updateTimer.unref();
  }

  private flushUpdates(): void {
    this.updateTimer = undefined;
    const coordinator = this.findRole('coordinator');
    if (!coordinator || getSettings().coordinatorMode === 'human') { this.pendingUpdates = []; return; }
    if (this.running.has(coordinator.id)) return; // retried when its turn ends

    const lines = this.pendingUpdates.splice(0);
    if (!lines.length) return;
    const text = `[AGENTIX UPDATE]\n${lines.map(l => `- ${l}`).join('\n')}\n\nTeam:\n${this.teamDigest(coordinator.id)}`;
    this.emit(coordinator.id, { type: 'message', from: 'system', text });
    this.startTurn(coordinator.id, text, 'system');
  }

  // ---------- messages and @@ commands ----------

  /** kenz writes to the coordinator (e.g. about a worker, in "agent" coordinator mode). */
  askCoordinator(text: string, about?: string): AgentEvent {
    if (!text) throw new HttpError(400, 'text is required');
    const coordinator = this.findRole('coordinator');
    if (!coordinator) throw new HttpError(409, 'There is no coordinator agent');
    const target = about ? store.getAgent(about) : undefined;
    const line = target ? `kenz about ${target.name} (${target.id}): "${text}"` : `kenz: "${text}"`;
    const event = this.emit(coordinator.id, { type: 'message', from: 'user', text: target ? `About ${target.name}: ${text}` : text });
    if (getSettings().coordinatorMode === 'human') return event;
    this.pendingUpdates.push(line);
    this.scheduleFlush();
    return event;
  }

  /** Find an agent by id, or by name (case-insensitive). */
  private resolve(target: string): Agent | undefined {
    const t = target.trim().replace(/^["']|["']$/g, '');
    const agents = store.getAgents();
    return agents.find(a => a.id === t) ?? agents.find(a => a.name.toLowerCase() === t.toLowerCase())
      ?? (['coordinator', 'ceo'].includes(t.toLowerCase()) ? agents.find(a => a.role === t.toLowerCase()) : undefined);
  }

  /** Run the @@ commands in a coordinator's or CEO's output. */
  private runCommands(sourceId: string, text: string): void {
    const source = store.getAgent(sourceId);
    if (!source || source.role === 'worker') return;
    const { commands, errors } = parseCommands(text);
    const fail = (msg: string) => this.emit(sourceId, { type: 'error', from: 'system', text: msg });
    for (const e of errors) fail(e);
    if (!commands.length) return;
    if (source.role === 'coordinator' && getSettings().coordinatorMode === 'human') {
      fail(`Coordinator mode is "human", so ${commands.length} command(s) were not run`);
      return;
    }
    for (const c of commands) {
      // Run each command on its own tick so a spawn/steer never re-enters the turn that produced it.
      queueMicrotask(() => this.runCommand(source, c).catch(err => fail(`${c.line}: ${err?.message ?? err}`)));
    }
  }

  private async runCommand(source: Agent, c: Command): Promise<void> {
    if (source.role === 'ceo') {
      // The CEO talks to the coordinator and nobody else.
      if (c.op !== 'tell' || !['coordinator', this.findRole('coordinator')?.id, this.findRole('coordinator')?.name.toLowerCase()].includes(c.target.toLowerCase())) {
        throw new Error('the CEO can only "@@tell coordinator :: <message>"');
      }
      const coordinator = this.findRole('coordinator');
      if (!coordinator || getSettings().coordinatorMode === 'human') {
        this.emit(source.id, { type: 'message', from: 'system', text: `No coordinator agent is running; kenz is coordinating. Message kept here: ${c.text}` });
        return;
      }
      this.emit(coordinator.id, { type: 'message', from: source.id, text: c.text });
      this.pendingUpdates.push(`CEO ${source.name} says: "${c.text}"`);
      this.scheduleFlush();
      return;
    }

    switch (c.op) {
      case 'spawn': {
        const o = c.opts;
        const role = (o.role as Role | undefined) ?? 'worker';
        if (role !== 'worker') throw new Error('the coordinator can only spawn workers');
        const avatarId = o.avatar === undefined || o.avatar === 'random' ? 'random' : Number(o.avatar);
        const agent = this.createAgent(o.kind, { name: o.name, avatarId, cwd: o.cwd, from: source.id });
        if (c.text) {
          this.emit(agent.id, { type: 'message', from: source.id, text: c.text });
          this.startTurn(agent.id, c.text, source.id);
        }
        return;
      }
      case 'steer': {
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.id === source.id) throw new Error('an agent cannot steer itself');
        if (target.role === 'ceo') throw new Error('use "@@tell ceo :: ..." to report to the CEO');
        await this.steerAgent(target.id, c.text, source.id);
        return;
      }
      case 'stop': {
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.role !== 'worker') throw new Error('the coordinator can only stop workers');
        this.emit(target.id, { type: 'message', from: source.id, text: 'stop' });
        await this.interruptAgent(target.id);
        return;
      }
      case 'tell': {
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.role !== 'ceo') throw new Error('use "@@steer <worker> :: ..." to direct workers');
        this.emit(target.id, { type: 'message', from: source.id, text: c.text });
        const msg = `[FROM COORDINATOR ${source.name}]\n${c.text}`;
        if (this.running.has(target.id)) {
          this.inbox.set(target.id, [...(this.inbox.get(target.id) ?? []), msg]);
        } else {
          this.startTurn(target.id, msg, source.id);
        }
        return;
      }
    }
  }

  /** One line per agent plus the start of its latest output. */
  teamDigest(excludeId?: string): string {
    const agents = store.getAgents().filter(a => a.id !== excludeId);
    if (!agents.length) return '(no other agents)';
    return agents.map(a => {
      const last = store.getAgentEvents(a.id, 0, 50).filter(e => e.type === 'output').pop();
      const out = last?.text ? `\n    last output: ${oneLine(last.text, 200)}` : '';
      return `- ${a.name} (${a.id}, ${a.kind}, ${a.role}): ${a.status} — ${a.activity}${out}`;
    }).join('\n');
  }
}
