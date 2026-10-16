// Agentix — session manager (spawn, steer, stop, restart) and coordinator updates
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { Agent, AgentEvent, Role, Status } from '../../shared/src/types.ts';
import { NAMES } from '../../shared/src/types.ts';
import { getAdapter, mockEnabled } from './adapters/index.ts';
import { unavailableModelError } from './adapters/models.ts';
import { KILL_GRACE_MS, oneLine } from './adapters/proc.ts';
import { store, AGENTIX_HOME } from './store.ts';
import { EventBus } from './bus.ts';
import { getSettings } from './settings.ts';
import { parseCommands, COORDINATOR_INSTRUCTIONS, CEO_INSTRUCTIONS, type Command } from './commands.ts';
import { roleGuide } from './roles.ts';
import { addNote, sharedContextBlock } from './context.ts';
import { createWorktree, worktreeStatus, mergeWorktree, discardWorktree, removeWorktree, GitError, type WorktreeStatus } from './worktree.ts';
import { listTasks, createTask, updateTask, deleteTask, getTask, TaskError, TASK_STATUSES } from './tasks.ts';
import type { Task, TaskStatus } from '../../shared/src/types.ts';

const ROLES: Role[] = ['ceo', 'coordinator', 'worker'];
const BUSY: Status[] = ['starting', 'thinking', 'working'];

/** How long to batch coordinator updates before sending them as one turn. */
const UPDATE_DELAY_MS = Number(process.env.AGENTIX_UPDATE_DELAY_MS) || 5000;
const CEO_REPLY_TIMEOUT_MS = Math.max(1000, Number(process.env.AGENTIX_CEO_REPLY_TIMEOUT_MS) || 30_000);
const CEO_REPLY_ATTEMPTS = 3;

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

interface PendingCeoRequest {
  ceoId: string;
  coordinatorId: string;
  text: string;
  attempts: number;
  timer?: NodeJS.Timeout;
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
  /** false: work directly in cwd even when it is a git repo (workers only; default from settings) */
  worktree?: boolean;
  /** the model for the CLI's model flag; empty = the CLI's default */
  model?: string;
}

/** A model name as the CLI's flag takes it: trimmed, no spaces or quotes, empty = default. */
export function cleanModel(model: unknown): string | undefined {
  if (model == null) return undefined;
  const m = String(model).trim();
  if (!m) return undefined;
  if (m.length > 200 || /[\s"'`\\]/.test(m) || m.startsWith('-')) throw new HttpError(400, `Not a model name: ${m.slice(0, 60)}`);
  return m;
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
  /** One outstanding CEO request per CEO; follow-ups never interrupt a coordinator turn. */
  private pendingCeoRequests = new Map<string, PendingCeoRequest>();
  /** when each agent's last turn ended, so the CEO watchdog only counts time the coordinator was idle */
  private lastTurnEnd = new Map<string, number>();
  /** messages waiting for an agent to finish its current turn (CEO <- coordinator) */
  private inbox = new Map<string, string[]>();
  /** role whose instructions each agent has already been given in its current session */
  private briefed = new Map<string, Role>();

  constructor(bus: EventBus) {
    this.bus = bus;
    // Mock agents left over from before the mock adapter was hidden: drop them and their history.
    if (!mockEnabled()) for (const a of store.getAgents()) if (a.kind === 'mock') store.removeAgent(a.id);
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
  /** every agent ever created, removed ones (archivedAt set) included */
  getAllAgents(): Agent[] { return store.getAllAgents(); }
  getAgent(id: string, includeArchived = false): Agent | undefined { return store.getAgent(id, includeArchived); }
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

    let id = 'a_' + randomUUID().slice(0, 6);
    while (store.getAgent(id, true)) id = 'a_' + randomUUID().slice(0, 6); // removed agents keep their ids
    const model = cleanModel(opts.model);
    this.claimRole(role, id, opts.replace);
    const name = opts.name || pickName();

    // Workers in a git repo get their own worktree and branch, so they never overwrite each other.
    let worktree: Agent['worktree'];
    let worktreeError: string | undefined;
    if (role === 'worker' && getSettings().worktrees && opts.worktree !== false) {
      try {
        const wt = createWorktree(cwd, id, name);
        if (wt) { worktree = wt.worktree; cwd = wt.cwd; }
      } catch (err: any) { worktreeError = err?.message ?? String(err); }
    }

    const agent: Agent = {
      id,
      name,
      kind: kind as Agent['kind'],
      role,
      avatarId,
      cwd,
      status: 'idle',
      activity: 'idle',
      createdAt: Date.now(),
      ...(worktree ? { worktree } : {}),
      ...(model ? { model } : {}),
    };
    store.createAgent(agent);
    this.emit(id, { type: 'agent.created', from: opts.from ?? 'user', text: `Agent ${agent.name} created (${kind}${model ? ` ${model}` : ''}, ${role})`, data: agent });
    if (worktree) this.emit(id, { type: 'message', from: 'system', text: `Working on branch ${worktree.branch} in its own worktree (${worktree.path}), from ${worktree.repo}` });
    if (worktreeError) this.emit(id, { type: 'error', from: 'system', text: `No worktree (${oneLine(worktreeError, 200)}); working directly in ${cwd}` });

    if (opts.prompt) {
      // Keep the first task in the history like any later instruction.
      this.emit(id, { type: 'message', from: opts.from ?? 'user', text: opts.prompt });
      this.startTurn(id, opts.prompt, opts.from ?? 'user');
    }
    return store.getAgent(id)!;
  }

  updateAgent(id: string, patch: { name?: string; avatarId?: number; role?: Role; cwd?: string; replace?: boolean; model?: string | null }): Agent {
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
    if (patch.model !== undefined) {
      // takes effect from the agent's next turn
      const model = cleanModel(patch.model);
      if (model) agent.model = model; else delete agent.model;
    }
    store.updateAgent(agent);
    this.emit(id, { type: 'agent.updated', text: `Agent ${agent.name} updated`, data: agent });
    return agent;
  }

  /** Take an agent out of the office. Its record and full history stay (in the database and history files). */
  async removeAgent(id: string): Promise<void> {
    const agent = this.requireAgent(id);
    await this.interruptAgent(id);
    if (agent.worktree) {
      const kept = removeWorktree(agent.worktree, agent.name);
      this.emit(id, { type: 'message', from: 'system', text: kept
        ? `Worktree removed; unmerged work kept on branch ${agent.worktree.branch} in ${agent.worktree.repo}`
        : `Worktree removed (no unmerged work)` });
    }
    store.archiveAgent(id);
    this.inbox.delete(id);
    this.briefed.delete(id);
    this.clearCeoRequestsForAgent(id);
    this.emit(id, { type: 'agent.removed', text: `Agent ${agent.name} removed (history kept)` });
  }

  /**
   * Start the agent on a fresh native session: the next message begins a new conversation with no memory
   * of the old one (role instructions are sent again). With `clear`, dashboards also hide the earlier events;
   * they stay in the history.
   */
  async newSession(id: string, clear = false): Promise<AgentEvent> {
    this.requireAgent(id);
    await this.interruptAgent(id);
    const agent = this.requireAgent(id); // re-read: interrupting changed its status
    delete agent.nativeSessionId;
    store.updateAgent(agent);
    this.inbox.delete(id);
    this.briefed.delete(id);
    this.clearCeoRequestsForAgent(id);
    this.setStatus(id, 'idle', clear ? 'idle (cleared)' : 'idle (new session)');
    return this.emit(id, { type: 'session', from: 'user', text: clear ? 'Session cleared' : 'New session started', data: { clear } });
  }

  // ---------- worktrees ----------

  private requireWorktree(id: string): Agent & { worktree: NonNullable<Agent['worktree']> } {
    const agent = this.requireAgent(id);
    if (!agent.worktree) throw new HttpError(404, `${agent.name} has no worktree (it was not started in a git repo)`);
    return agent as any;
  }

  private gitCall<T>(fn: () => T): T {
    try { return fn(); } catch (err) { if (err instanceof GitError) throw new HttpError(409, err.message); throw err; }
  }

  getWorktree(id: string): WorktreeStatus {
    const agent = this.requireWorktree(id);
    return this.gitCall(() => worktreeStatus(agent.worktree));
  }

  /** Commit the worker's changes and merge its branch into the repo's checked-out branch. */
  mergeWorktree(id: string): { merged: string; into: string } {
    const agent = this.requireWorktree(id);
    if (this.running.has(id)) throw new HttpError(409, `${agent.name} is working; wait until it is idle or interrupt it`);
    const r = this.gitCall(() => mergeWorktree(agent.worktree, agent.name));
    store.updateAgent({ ...agent, worktree: r.worktree });
    this.emit(id, { type: 'message', from: 'user', text: `Merged ${agent.worktree.branch} into ${r.into} (${r.merged.slice(0, 8)})`, data: r });
    this.queueUpdate(`kenz merged ${agent.name}'s branch ${agent.worktree.branch} into ${r.into}`);
    return { merged: r.merged, into: r.into };
  }

  /** Throw away the worker's changes since the last merge. */
  discardWorktree(id: string): void {
    const agent = this.requireWorktree(id);
    if (this.running.has(id)) throw new HttpError(409, `${agent.name} is working; wait until it is idle or interrupt it`);
    this.gitCall(() => discardWorktree(agent.worktree));
    this.emit(id, { type: 'message', from: 'user', text: `Discarded the changes on ${agent.worktree.branch}` });
    this.queueUpdate(`kenz discarded ${agent.name}'s changes on ${agent.worktree.branch}`);
  }

  // ---------- task board ----------

  private emitTask(task: Task, from: string, verb: string): void {
    const who = task.owner ? store.getAgent(task.owner, true)?.name ?? task.owner : undefined;
    this.emit(task.owner ?? (from !== 'user' && from !== 'system' ? from : 'team'), {
      type: 'task', from, text: `${verb} ${task.id} [${task.status}]${who ? ` (${who})` : ''}: ${task.title}`, data: task,
    });
  }

  private taskCall<T>(fn: () => T): T {
    try { return fn(); } catch (err) { if (err instanceof TaskError) throw new HttpError(400, err.message); throw err; }
  }

  addTask(fields: { title: string; owner?: string; status?: TaskStatus; note?: string }, from = 'user'): Task {
    const owner = fields.owner ? this.resolve(fields.owner)?.id : undefined;
    if (fields.owner && !owner) throw new HttpError(400, `no agent called "${fields.owner}"`);
    const task = this.taskCall(() => createTask({ ...fields, owner, by: from }));
    this.emitTask(task, from, 'New task');
    if (from === 'user') {
      this.queueUpdate(`kenz added task ${task.id}: ${task.title}`);
      this.startAssignedTask(task, from);
    }
    return task;
  }

  editTask(id: string, patch: { title?: string; status?: TaskStatus; owner?: string | null; note?: string }, from = 'user'): Task {
    const before = getTask(id);
    if (!before) throw new HttpError(404, `no task ${id}`);
    let owner = patch.owner;
    if (owner) {
      const a = this.resolve(owner);
      if (!a) throw new HttpError(400, `no agent called "${owner}"`);
      owner = a.id;
    }
    const task = this.taskCall(() => updateTask(id, { ...patch, owner }));
    this.emitTask(task, from, 'Task');
    if (from === 'user') this.queueUpdate(`kenz changed task ${task.id} to ${task.status}: ${task.title}`);
    // A to-do task handed to a (different) worker starts it, from the board or from the coordinator.
    if (task.owner && task.owner !== before.owner) this.startAssignedTask(task, from);
    return task;
  }

  removeTask(id: string): void {
    const task = getTask(id);
    if (!task || !deleteTask(id)) throw new HttpError(404, `no task ${id}`);
    this.emit(task.owner ?? 'team', { type: 'task', from: 'user', text: `Deleted ${task.id}: ${task.title}`, data: { ...task, deleted: true } });
  }

  /** Move a worker's tasks along without anyone asking: doing while it works, review or blocked after. */
  private advanceTasks(agentId: string, from: TaskStatus[], to: TaskStatus): void {
    for (const t of listTasks()) {
      if (t.owner === agentId && from.includes(t.status)) this.emitTask(updateTask(t.id, { status: to }), 'system', 'Task');
    }
  }

  /** Start a newly assigned worker task, or queue it behind the worker's current turn. */
  private startAssignedTask(task: Task, from: string): void {
    if (task.status !== 'todo' || !task.owner) return;
    const worker = store.getAgent(task.owner);
    if (!worker || worker.role !== 'worker') return;
    const prompt = `[TASK ${task.id}] ${task.title}`;
    if (this.running.has(worker.id)) {
      this.inbox.set(worker.id, [...(this.inbox.get(worker.id) ?? []), prompt]);
    } else {
      this.startTurn(worker.id, prompt, from);
    }
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

    // Every agent gets its role instructions and AGENTS.md guidance once per session (again after a role change).
    let instructions: string | undefined;
    if (!agent.nativeSessionId || this.briefed.get(agentId) !== agent.role) {
      const commands = agent.role === 'coordinator' ? COORDINATOR_INSTRUCTIONS : agent.role === 'ceo' ? CEO_INSTRUCTIONS : '';
      instructions = [commands, roleGuide(agent.role)].filter(Boolean).join('\n\n') || undefined;
    }
    this.briefed.set(agentId, agent.role);
    if (agent.role === 'worker') this.advanceTasks(agentId, ['todo', 'review', 'blocked'], 'doing');
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
          if (e.type === 'output' && e.text) this.runCommands(agentId, e.text);
        }
      },
      setNativeSessionId: (sid: string) => {
        if (signal.aborted || agent.nativeSessionId === sid) return; // e.g. a turn stopped by "new session"

        agent.nativeSessionId = sid;
        store.setNativeSessionId(agentId, sid);
      },
    };

    const done = (async () => {
      let failure: string | undefined;
      try {
        // Workers and the coordinator see the team brief, shared notes and related findings of other agents.
        if (agent.role !== 'ceo') {
          const shared = await sharedContextBlock(agent, prompt);
          if (shared) prompt = `${shared}\n\n${prompt}`;
        }
        if (signal.aborted) throw new Error('interrupted');
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
    for (const pending of this.pendingCeoRequests.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pendingCeoRequests.clear();
  }

  /** Stop every turn and remove the live workspace state for a clean first launch. */
  async resetWorkspace(): Promise<void> {
    await this.shutdown();
    this.pendingUpdates = [];
    this.inbox.clear();
    this.briefed.clear();
    for (const agent of store.getAgents()) {
      if (agent.worktree) {
        try { removeWorktree(agent.worktree, agent.name); } catch { /* keep the user's repository safe */ }
      }
      store.removeAgent(agent.id);
    }
    store.reset();
  }

  // ---------- coordinator updates ----------

  private findRole(role: Role): Agent | undefined {
    return store.getAgents().find(a => a.role === role);
  }

  private onTurnEnd(agentId: string, aborted: boolean, failure?: string): void {
    this.lastTurnEnd.set(agentId, Date.now());
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
    this.advanceTasks(agentId, ['doing'], failure ? 'blocked' : 'review');
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

  /** Run the @@ commands in an agent's output: @@remember from anyone, the rest from the coordinator or CEO. */
  private runCommands(sourceId: string, text: string): void {
    const source = store.getAgent(sourceId);
    if (!source) return;
    const parsed = parseCommands(text);
    for (const c of parsed.commands) {
      if (c.op !== 'remember') continue;
      const note = addNote(c.text, source.id);
      if (note) this.emit(sourceId, { type: 'message', from: 'system', text: `Saved to shared context: ${oneLine(c.text, 200)}`, data: { note } });
    }
    if (source.role === 'worker') {
      // A worker may move its own tasks (e.g. "@@task t3 status=done").
      for (const c of parsed.commands) {
        if (c.op !== 'task' || !c.id) continue;
        const t = getTask(c.id);
        if (!t || t.owner !== source.id) { this.emit(sourceId, { type: 'error', from: 'system', text: `${c.line}: not one of your tasks` }); continue; }
        try { this.editTask(c.id, { status: c.opts.status as TaskStatus | undefined, ...(c.text ? { note: c.text } : {}) }, source.id); }
        catch (err: any) { this.emit(sourceId, { type: 'error', from: 'system', text: `${c.line}: ${err?.message ?? err}` }); }
      }
      return;
    }
    const commands = parsed.commands.filter(c => c.op !== 'remember');
    const errors = parsed.errors;
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
      this.trackCeoRequest(source, coordinator, c.text);
      this.scheduleFlush();
      return;
    }

    switch (c.op) {
      case 'remember': return; // handled in runCommands
      case 'task': {
        const status = c.opts.status as TaskStatus | undefined;
        if (status && !TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join(', ')}`);
        if (c.id) this.editTask(c.id, { status, ...(c.opts.owner ? { owner: c.opts.owner } : {}), ...(c.text ? { note: c.text } : {}) }, source.id);
        else {
          const task = this.addTask({ title: c.text, owner: c.opts.owner, status }, source.id);
          this.startAssignedTask(task, source.id);
        }
        return;
      }
      case 'spawn': {
        const o = c.opts;
        const role = (o.role as Role | undefined) ?? 'worker';
        if (role !== 'worker') throw new Error('the coordinator can only spawn workers');
        const avatarId = o.avatar === undefined || o.avatar === 'random' ? 'random' : Number(o.avatar);
        const worktree = o.worktree === undefined ? undefined : !/^(no|false|off|0)$/i.test(o.worktree);
        const model = cleanModel(o.model);
        if (model) {
          const modelError = await unavailableModelError(o.kind, model);
          if (modelError) throw new Error(modelError);
        }
        // The task goes on the board before the worker starts, so its first turn moves it to doing.
        const created = this.createAgent(o.kind, { name: o.name, avatarId, cwd: o.cwd, from: source.id, worktree, model });
        if (c.text) {
          this.addTask({ title: oneLine(c.text, 140), owner: created.id, status: 'todo' }, source.id);
          this.emit(created.id, { type: 'message', from: source.id, text: c.text });
          this.startTurn(created.id, c.text, source.id);
        }
        return;
      }
      case 'steer': {
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.id === source.id) throw new Error('an agent cannot steer itself');
        // Older coordinator turns sometimes used @@steer for a CEO report. Treat it as
        // @@tell so that a harmless wording mismatch does not lose the delegation update
        // or interrupt the CEO's current turn.
        if (target.role === 'ceo') {
          this.tellCeo(source, target, c.text);
          return;
        }
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
        this.tellCeo(source, target, c.text);
        return;
      }
    }
  }

  /** Deliver a coordinator report to the CEO without interrupting an active CEO turn. */
  private tellCeo(source: Agent, target: Agent, text: string): void {
    this.clearCeoRequest(target.id, source.id);
    this.emit(target.id, { type: 'message', from: source.id, text });
    const msg = `[FROM COORDINATOR ${source.name}]\n${text}`;
    if (this.running.has(target.id)) {
      this.inbox.set(target.id, [...(this.inbox.get(target.id) ?? []), msg]);
    } else {
      this.startTurn(target.id, msg, source.id);
    }
  }

  private trackCeoRequest(ceo: Agent, coordinator: Agent, text: string): void {
    this.clearCeoRequest(ceo.id);
    const pending: PendingCeoRequest = { ceoId: ceo.id, coordinatorId: coordinator.id, text, attempts: 1 };
    this.pendingCeoRequests.set(ceo.id, pending);
    this.armCeoRequestTimer(pending);
  }

  private armCeoRequestTimer(pending: PendingCeoRequest, ms = CEO_REPLY_TIMEOUT_MS): void {
    pending.timer = setTimeout(() => this.onCeoRequestTimeout(pending), ms);
    pending.timer.unref();
  }

  private onCeoRequestTimeout(pending: PendingCeoRequest): void {
    if (this.pendingCeoRequests.get(pending.ceoId) !== pending) return;
    const ceo = store.getAgent(pending.ceoId);
    const coordinator = store.getAgent(pending.coordinatorId);
    if (!ceo || !coordinator || this.findRole('coordinator')?.id !== pending.coordinatorId || getSettings().coordinatorMode === 'human') {
      this.reportCeoIssue(pending, 'the coordinator is unavailable or coordinator mode is set to human');
      return;
    }
    // Only idle time counts: a coordinator that is working (or just finished) hasn't ignored the request.
    const quiet = Date.now() - (this.lastTurnEnd.get(coordinator.id) ?? 0);
    if (this.running.has(coordinator.id) || quiet < CEO_REPLY_TIMEOUT_MS) {
      this.armCeoRequestTimer(pending, this.running.has(coordinator.id) ? CEO_REPLY_TIMEOUT_MS : CEO_REPLY_TIMEOUT_MS - quiet);
      return;
    }
    if (pending.attempts >= CEO_REPLY_ATTEMPTS) {
      this.reportCeoIssue(pending, `no reply after ${CEO_REPLY_ATTEMPTS} requests`);
      return;
    }

    pending.attempts++;
    const followUp = `[Agentix follow-up ${pending.attempts}/${CEO_REPLY_ATTEMPTS}] ${ceo.name} has not received a reply. Please acknowledge the request or report any blocker. Original request: ${pending.text}`;
    this.emit(coordinator.id, { type: 'message', from: ceo.id, text: followUp });
    this.pendingUpdates.push(`CEO ${ceo.name} is still waiting for a coordinator reply (${pending.attempts}/${CEO_REPLY_ATTEMPTS}): "${pending.text}"`);
    this.scheduleFlush();
    this.armCeoRequestTimer(pending);
  }

  private reportCeoIssue(pending: PendingCeoRequest, reason: string): void {
    const ceo = store.getAgent(pending.ceoId);
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCeoRequests.delete(pending.ceoId);
    if (!ceo) return;
    this.emit(ceo.id, {
      type: 'error', from: 'system',
      text: `Agentix could not get a response to your coordinator request: ${reason}. The active run was not interrupted.`,
      data: { coordinatorId: pending.coordinatorId, attempts: pending.attempts },
    });
  }

  private clearCeoRequest(ceoId: string, coordinatorId?: string): void {
    const pending = this.pendingCeoRequests.get(ceoId);
    if (!pending || (coordinatorId && pending.coordinatorId !== coordinatorId)) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCeoRequests.delete(ceoId);
  }

  private clearCeoRequestsForAgent(agentId: string): void {
    for (const pending of this.pendingCeoRequests.values()) {
      if (pending.ceoId === agentId || pending.coordinatorId === agentId) this.clearCeoRequest(pending.ceoId);
    }
  }

  /** One line per agent plus the start of its latest output. */
  teamDigest(excludeId?: string): string {
    const agents = store.getAgents().filter(a => a.id !== excludeId);
    const open = listTasks().filter(t => t.status !== 'done');
    const names = new Map(store.getAllAgents().map(a => [a.id, a.name]));
    const tasks = open.length
      ? `\nTasks (not done):\n${open.map(t => `- ${t.id} [${t.status}] ${t.title}${t.owner ? ` (${names.get(t.owner) ?? t.owner})` : ''}`).join('\n')}`
      : '';
    if (!agents.length) return `(no other agents)${tasks}`;
    return agents.map(a => {
      const last = store.getAgentEvents(a.id, 0, 50).filter(e => e.type === 'output').pop();
      const out = last?.text ? `\n    last output: ${oneLine(last.text, 200)}` : '';
      const branch = a.worktree ? ` [branch ${a.worktree.branch}]` : '';
      return `- ${a.name} (${a.id}, ${a.kind}, ${a.role})${branch}: ${a.status} — ${a.activity}${out}`;
    }).join('\n') + tasks;
  }
}
