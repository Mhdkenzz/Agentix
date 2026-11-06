// Agentix — session manager (spawn, steer, stop, restart) and coordinator updates
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Agent, AgentEvent, PermissionDecision, PermissionRequest, Role, Status } from '../../shared/src/types.ts';
import { NAMES } from '../../shared/src/types.ts';
import { getAdapter, mockEnabled } from './adapters/index.ts';
import { unavailableModelError } from './adapters/models.ts';
import { KILL_GRACE_MS, oneLine } from './adapters/proc.ts';
import { store, AGENTIX_HOME } from './store.ts';
import { readPendingWork, writePendingWork, clearPendingWork, MAX_INBOX_MESSAGES, MAX_INBOX_MESSAGE, type PendingTurn } from './pending.ts';
import { EventBus } from './bus.ts';
import { getSettings } from './settings.ts';
import { parseCommands, COORDINATOR_INSTRUCTIONS, CEO_INSTRUCTIONS, type Command } from './commands.ts';
import { roleGuide } from './roles.ts';
import { ApprovalError, createPermissionRequest, decidePermissionRequest, listPermissionRequests, markPermissionRequestApplied } from './approvals.ts';
import { addNote, sharedContextBlock } from './context.ts';
import { listTasks, createTask, updateTask, deleteTask, getTask, releaseInterruptedTasks, startTaskAttempt, TaskError, TASK_STATUSES } from './tasks.ts';
import type { AgentChat, Task, TaskStatus } from '../../shared/src/types.ts';

const ROLES: Role[] = ['ceo', 'coordinator', 'worker'];
const BUSY: Status[] = ['starting', 'thinking', 'working'];

/** How long to batch coordinator updates before sending them as one turn. */
const UPDATE_DELAY_MS = Number(process.env.AGENTIX_UPDATE_DELAY_MS) || 5000;
const CEO_REPLY_TIMEOUT_MS = Math.max(1000, Number(process.env.AGENTIX_CEO_REPLY_TIMEOUT_MS) || 30_000);
const CEO_REPLY_ATTEMPTS = 3;

/** A turn that runs longer than this is stopped, so a hung agent cannot hold the office hostage. */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
/** How many turns in a row an agent may get just to hear that one of its commands failed. */
const MAX_RESULT_TURNS = 3;
/** A turn that is ready while the office is at its limit waits here instead of being dropped. */
const MAX_QUEUED_TURNS = 100;
/** Retry a task once when the CLI reports a recognizable transient service/network failure. */
const MAX_AUTOMATIC_TASK_RETRIES = 1;
/** How much of one event goes into the database and the event stream (a CLI can print a whole file). */
const MAX_EVENT_TEXT = 100_000;
const MAX_EVENT_DATA = 64_000;

function isTransientTaskFailure(failure: string): boolean {
  return /\b429\b|\b(?:502|503|504)\b|rate[\s_-]*limit|temporar(?:y|ily)|overloaded|service unavailable|network|fetch failed|socket hang up|connection (?:reset|closed|refused)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/i.test(failure);
}

function appendTaskNote(previous: string | undefined, latest: string): string {
  const current = previous?.trim();
  const recent = latest.slice(0, 600);
  const earlier = current?.slice(0, 1_000 - recent.length - 2);
  return earlier ? `${earlier}\n\n${recent}` : recent;
}

/** Read an environment number at every use, so tests can change it while the server runs. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** How long a turn may run (0 = no limit). */
export const turnTimeoutMs = () => envMs('AGENTIX_TURN_TIMEOUT_MS', DEFAULT_TURN_TIMEOUT_MS);
/** How many agents may be in the office at once. */
export const maxAgents = () => Math.max(1, Number(process.env.AGENTIX_MAX_AGENTS) || 64);
/** How many turns may run at the same time. */
export const maxConcurrentTurns = () => Math.max(1, Number(process.env.AGENTIX_MAX_CONCURRENT_TURNS) || 12);

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
  /** the instruction as it was asked for, kept so a restart can offer the turn again */
  prompt: string;
  from: string;
  startedAt: number;
  taskId?: string;
  timedOut?: boolean;
  timeoutMessage?: string;
}

/** A turn waiting for a free slot at the office limit, in the order it was asked for. */
interface QueuedTurn {
  agentId: string;
  prompt: string;
  from: string;
  taskId?: string;
}

/**
 * Keep one event from filling the database: agent CLIs print whole files and command outputs,
 * and every event is kept in SQLite, in the history file and in the client's stream.
 */
function capEvent(e: NewEvent): NewEvent {
  let out = e;
  if (typeof e.text === 'string' && e.text.length > MAX_EVENT_TEXT) {
    const hidden = e.text.length - MAX_EVENT_TEXT;
    out = { ...out, text: `${e.text.slice(0, MAX_EVENT_TEXT)}\n… (${hidden.toLocaleString('en-US')} more characters were not stored)` };
  }
  if (out.data !== undefined) {
    let size = 0;
    try { size = JSON.stringify(out.data)?.length ?? 0; } catch { size = 0; }
    if (size > MAX_EVENT_DATA) out = { ...out, data: { truncated: true, bytes: size } };
  }
  return out;
}

/** What an agent sees when its turn is offered again after a restart: a resume, not a fresh duplicate. */
const RESTART_NOTE = '[AGENTIX] The server restarted';
const interruptedTurnPrompt = (prompt: string) =>
  prompt.startsWith(RESTART_NOTE)
    ? prompt // a second crash during the resume must not stack the note
    : `${RESTART_NOTE} in the middle of your last turn. Check what you already did (the files, the tests, the task) before continuing, then finish it.\n\n${prompt}`;
/** The instruction without the restart note, for log lines. */
const withoutRestartNote = (prompt: string) => prompt.startsWith(RESTART_NOTE) ? prompt.slice(prompt.indexOf('\n\n') + 2) : prompt;

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
  // Removed agents keep their name: a new agent with the same name would make the history ambiguous.
  const taken = new Set(store.getAllAgents().map(a => a.name));
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
  private removing = new Set<string>();
  private steerSequence = new Map<string, number>();
  private pendingUpdates: string[] = [];
  private updateTimer: NodeJS.Timeout | undefined;
  /** One outstanding CEO request per CEO; follow-ups never interrupt a coordinator turn. */
  private pendingCeoRequests = new Map<string, PendingCeoRequest>();
  /** when each agent's last turn ended, so the CEO watchdog only counts time the coordinator was idle */
  private lastTurnEnd = new Map<string, number>();
  /** messages waiting for an agent to finish its current turn (CEO <- coordinator) */
  private inbox = new Map<string, string[]>();
  /** turns ready to run but held back by AGENTIX_MAX_CONCURRENT_TURNS, oldest first */
  private queued: QueuedTurn[] = [];
  /** defer queued turns while session state is being reset */
  private pumpPaused = 0;
  /** true while shutting down: no queued or follow-up turn may start */
  private stopping = false;
  /** turns that were running at shutdown, offered again by the next server */
  private stoppedTurns: PendingTurn[] = [];
  /** the saved work is taken over once: a second call would re-offer this server's own turns */
  private resumed = false;
  /** the pending-work file could not be written: say so once, not on every turn */
  private warnedPending = false;
  /** What happened to the @@ commands an agent wrote; delivered at the start of its next turn. */
  private commandResults = new Map<string, string[]>();
  /** How many turns in a row an agent got just to hear that one of its commands failed. */
  private resultTurns = new Map<string, number>();
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
    const full = store.appendEvent(capEvent(e), agentId);
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

  /** Saved conversation boundaries are derived from durable session markers in the event history. */
  getChats(id: string): AgentChat[] {
    if (!store.getAgent(id, true)) throw new HttpError(404, `Agent ${id} not found`);
    const events = store.getAgentEvents(id);
    if (!events.length) return [];
    let starts = events.filter(e => e.type === 'agent.created' || e.type === 'session');
    if (!starts.length || starts[0].id > events[0].id) starts = [events[0], ...starts];
    const groups: AgentEvent[][] = starts.map(() => []);
    let group = 0;
    for (const event of events) {
      while (group + 1 < starts.length && starts[group + 1].id <= event.id) group++;
      groups[group].push(event);
    }
    return starts.map((start, i) => {
      const beforeEventId = starts[i + 1]?.id;
      const chatEvents = groups[i];
      const firstPrompt = chatEvents.find(e => (e.type === 'message' || e.type === 'steer') && e.from !== 'system' && e.text?.trim());
      const title = firstPrompt?.text?.trim() || (start.type === 'session' ? 'New session' : 'New chat');
      return {
        id: String(start.id), title: oneLine(title, 80), startedAt: start.ts,
        eventCount: chatEvents.length, startEventId: start.id,
        ...(beforeEventId === undefined ? {} : { beforeEventId }),
      };
    }).reverse();
  }

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

  async createAgent(kind: string, opts: CreateOptions = {}): Promise<Agent> {
    if (typeof kind !== 'string' || !kind.trim()) throw new HttpError(400, 'kind must be a non-empty string');
    if (opts.name !== undefined && typeof opts.name !== 'string') throw new HttpError(400, 'name must be a string');
    if (opts.cwd !== undefined && typeof opts.cwd !== 'string') throw new HttpError(400, 'cwd must be a string');
    if (opts.prompt !== undefined && typeof opts.prompt !== 'string') throw new HttpError(400, 'prompt must be a string');
    if (opts.replace !== undefined && typeof opts.replace !== 'boolean') throw new HttpError(400, 'replace must be a boolean');
    if (!getAdapter(kind)) throw new HttpError(400, `Unknown agent kind: ${kind}`);
    const role = opts.role ?? 'worker';
    if (!ROLES.includes(role)) throw new HttpError(400, `Unknown role: ${role}`);
    if (store.getAgents().length >= maxAgents()) {
      throw new HttpError(429, `The office is full: ${maxAgents()} agents are already here. Remove one first, or raise AGENTIX_MAX_AGENTS.`);
    }

    let avatarId: number;
    if (opts.avatarId === undefined || opts.avatarId === 'random') {
      avatarId = Math.floor(Math.random() * 10);
    } else {
      avatarId = Number(opts.avatarId);
      if (!Number.isInteger(avatarId) || avatarId < 0 || avatarId > 9) throw new HttpError(400, 'avatarId must be 0-9 or "random"');
    }

    const cwd = opts.cwd && opts.cwd !== '.' ? opts.cwd : join(AGENTIX_HOME, 'workspace');
    if (!isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path');
    mkdirSync(cwd, { recursive: true });

    let id = 'a_' + randomUUID().slice(0, 6);
    while (store.getAgent(id, true)) id = 'a_' + randomUUID().slice(0, 6); // removed agents keep their ids
    const model = cleanModel(opts.model);
    this.claimRole(role, id, opts.replace);
    const name = opts.name?.trim() || pickName();

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
      ...(model ? { model } : {}),
    };
    store.createAgent(agent);
    this.emit(id, { type: 'agent.created', from: opts.from ?? 'user', text: `Agent ${agent.name} created (${kind}${model ? ` ${model}` : ''}, ${role})`, data: agent });

    if (opts.prompt) {
      // Keep the first task in the history like any later instruction.
      this.emit(id, { type: 'message', from: opts.from ?? 'user', text: opts.prompt });
      this.startTurn(id, opts.prompt, opts.from ?? 'user');
    }
    return store.getAgent(id)!;
  }

  updateAgent(id: string, patch: { name?: string; avatarId?: number; role?: Role; cwd?: string; replace?: boolean; model?: string | null }): Agent {
    const agent = this.requireAgent(id);
    if (patch.name !== undefined && typeof patch.name !== 'string') throw new HttpError(400, 'name must be a string');
    if (patch.cwd !== undefined && typeof patch.cwd !== 'string') throw new HttpError(400, 'cwd must be a string');
    if (patch.replace !== undefined && typeof patch.replace !== 'boolean') throw new HttpError(400, 'replace must be a boolean');
    if (patch.role !== undefined) {
      if (!ROLES.includes(patch.role)) throw new HttpError(400, `Unknown role: ${patch.role}`);
      if (patch.role !== agent.role) {
        this.claimRole(patch.role, id, patch.replace);
        agent.role = patch.role;
      }
    }
    if (patch.name?.trim()) agent.name = patch.name.trim();
    if (patch.avatarId !== undefined) {
      const n = Number(patch.avatarId);
      if (!Number.isInteger(n) || n < 0 || n > 9) throw new HttpError(400, 'avatarId must be 0-9');
      agent.avatarId = n;
    }
    if (patch.cwd) {
      if (!isAbsolute(patch.cwd)) throw new HttpError(400, 'cwd must be an absolute path');
      if (this.running.has(id) && this.canonicalCwd(patch.cwd) !== this.canonicalCwd(agent.cwd)) {
        throw new HttpError(409, 'stop the agent before changing its working directory');
      }
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
    if (this.removing.has(id)) return;
    this.removing.add(id);
    const turn = this.running.get(id);
    this.queued = this.queued.filter(q => q.agentId !== id);
    this.inbox.delete(id);
    this.savePending();
    try {
      await this.interruptAgent(id);
      // The agent remains active, and its workspace reserved, until the adapter confirms exit.
      if (turn) await turn.done;
      // The tasks it owned go back on the board: nobody is working on them any more.
      this.releaseTasks(id, agent.name);
      store.archiveAgent(id);
    } finally {
      this.removing.delete(id);
    }
    this.queued = this.queued.filter(q => q.agentId !== id);
    this.inbox.delete(id);
    this.briefed.delete(id);
    this.commandResults.delete(id);
    this.resultTurns.delete(id);
    this.clearCeoRequestsForAgent(id);
    this.steerSequence.delete(id);
    this.emit(id, { type: 'agent.removed', text: `Agent ${agent.name} removed (history kept)` });
    this.savePending();
    this.pump();
  }

  /**
   * After a restart, tasks that were being worked on go back on the board: no agent is working on them
   * any more, and a task stuck in "doing" hides the work from everyone.
   */
  resumeInterruptedTasks(): number {
    const tasks = releaseInterruptedTasks();
    for (const task of tasks) {
      this.emit(task.owner ?? 'team', {
        type: 'task', from: 'system',
        text: `Task ${task.id} [todo]: ${task.title} (the server restarted while it was being worked on)`,
        data: task,
      });
    }
    return tasks.length;
  }

  /** An agent that leaves the office hands its open tasks back to the board. */
  private releaseTasks(agentId: string, name: string): void {
    for (const t of listTasks()) {
      if (t.owner !== agentId || t.status === 'done') continue;
      const updated = updateTask(t.id, { owner: null, status: 'todo' });
      this.emit(agentId, {
        type: 'task', from: 'system',
        text: `Task ${updated.id} [todo]: ${updated.title} (${name} left the office, so it is open again)`,
        data: updated,
      });
    }
  }

  /**
   * Start the agent on a fresh native session: the next message begins a new conversation with no memory
   * of the old one (role instructions are sent again). With `clear`, dashboards also hide the earlier events;
   * they stay in the history.
   */
  async newSession(id: string, clear = false): Promise<AgentEvent> {
    if (this.removing.has(id)) throw new HttpError(409, 'agent is being removed');
    this.requireAgent(id);
    this.pumpPaused++;
    try {
      await this.interruptAgent(id);
      // A CLI that ignored the interrupt is still writing in the old conversation.
      // Keep its session and task state intact until it actually exits.
      if (this.running.has(id)) throw new HttpError(409, 'the current turn is still stopping; try starting a new session again after it exits');
      const agent = this.requireAgent(id); // re-read: interrupting changed its status
      delete agent.nativeSessionId;
      store.updateAgent(agent);
      this.inbox.delete(id);
      this.briefed.delete(id);
      this.clearCeoRequestsForAgent(id);
      this.savePending();
      this.setStatus(id, 'idle', clear ? 'idle (cleared)' : 'idle (new session)');
      return this.emit(id, { type: 'session', from: 'user', text: clear ? 'Session cleared' : 'New session started', data: { clear } });
    } finally {
      this.pumpPaused--;
      if (!this.pumpPaused) this.pump();
    }
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
    if (fields.owner !== undefined && typeof fields.owner !== 'string') throw new HttpError(400, 'owner must be a worker name or id');
    const owner = fields.owner ? this.resolve(fields.owner)?.id : undefined;
    if (fields.owner && !owner) throw new HttpError(400, `no agent called "${fields.owner}"`);
    if (owner && store.getAgent(owner)?.role !== 'worker') throw new HttpError(400, 'tasks can only be assigned to worker agents');
    const task = this.taskCall(() => createTask({ ...fields, owner, by: from }));
    this.emitTask(task, from, 'New task');
    if (from === 'user') {
      this.queueUpdate(`kenz added task ${task.id}: ${task.title}`);
      this.startAssignedTask(task, from);
    }
    return task;
  }

  getPermissionRequests(): PermissionRequest[] { return listPermissionRequests(); }

  decidePermission(id: string, decision: PermissionDecision, decidedBy = 'user', note = ''): PermissionRequest {
    if (decision === 'approved' && !note.trim()) throw new HttpError(400, 'approval needs a clear boundary or scope');
    const current = listPermissionRequests().find(r => r.id === id);
    if (!current) throw new HttpError(404, `no permission request ${id}`);
    if (this.removing.has(current.workerId)) throw new HttpError(409, 'agent is being removed');
    const currentWorker = store.getAgent(current.workerId, true);
    if (decision === 'approved' && (!currentWorker || currentWorker.archivedAt)) {
      throw new HttpError(409, `permission request ${id} is stale; its worker is no longer active`);
    }
    if (decision === 'approved' && current.taskId) {
      const task = getTask(current.taskId);
      if (!task || task.owner !== current.workerId || task.status !== 'blocked') {
        throw new HttpError(409, `permission request ${id} is stale; its task is no longer blocked and assigned to that worker`);
      }
    }
    let request: PermissionRequest;
    try { request = decidePermissionRequest(id, decision, decidedBy, note); }
    catch (err: any) { if (err instanceof ApprovalError) throw new HttpError(400, err.message); throw err; }
    const worker = store.getAgent(request.workerId, true);
    if (decision === 'approved' && worker && !worker.archivedAt) {
      if (request.taskId) {
        const task = getTask(request.taskId);
        if (task && task.owner === worker.id && task.status === 'blocked') {
          const reopened = updateTask(task.id, { status: 'todo', note: `Permission ${id} approved: ${note}` });
          this.emitTask(reopened, decidedBy, 'Task');
        }
      }
      if (!this.startTurn(worker.id, `[APPROVAL ${id}] Approved: ${note}\nOriginal request: ${request.request}`, decidedBy, request.taskId)) {
        throw new HttpError(429, 'approval saved but the worker queue is full; it will be retried when capacity is available');
      }
      markPermissionRequestApplied(id);
    } else if (decision === 'declined' && worker && !worker.archivedAt) {
      this.emit(worker.id, { type: 'message', from: decidedBy, text: `[PERMISSION ${id} DECLINED] ${note || 'The request was declined.'}\nThe related task remains blocked.` });
    }
    return request;
  }

  /** Finish approved requests interrupted between their durable decision and queued turn. */
  recoverApprovedPermissions(): number {
    let recovered = 0;
    for (const request of listPermissionRequests()) {
      if (request.status !== 'approved' || request.appliedAt) continue;
      const worker = store.getAgent(request.workerId);
      const task = request.taskId ? getTask(request.taskId) : undefined;
      if (!worker || (request.taskId && (!task || task.owner !== worker.id || !['blocked', 'todo'].includes(task.status)))) {
        markPermissionRequestApplied(request.id);
        continue;
      }
      if (task?.status === 'blocked') {
        const reopened = updateTask(task.id, { status: 'todo', note: `Permission ${request.id} approved: ${request.decision ?? ''}` });
        this.emitTask(reopened, request.decidedBy ?? 'system', 'Task');
      }
      const marker = `[APPROVAL ${request.id}]`;
      const alreadyOffered = this.queued.some(turn => turn.agentId === worker.id && turn.prompt.includes(marker))
        || this.running.get(worker.id)?.prompt.includes(marker);
      if (alreadyOffered) {
        markPermissionRequestApplied(request.id);
        continue;
      }
      if (this.startTurn(worker.id, `${marker} Approved: ${request.decision ?? ''}\nOriginal request: ${request.request}`, request.decidedBy ?? 'system', request.taskId)) {
        markPermissionRequestApplied(request.id);
        recovered++;
      }
    }
    return recovered;
  }

  editTask(id: string, patch: { title?: string; status?: TaskStatus; owner?: string | null; note?: string }, from = 'user'): Task {
    const before = getTask(id);
    if (!before) throw new HttpError(404, `no task ${id}`);
    if (patch.owner !== undefined && patch.owner !== null && typeof patch.owner !== 'string') {
      throw new HttpError(400, 'owner must be a worker name, id, or null');
    }
    let owner = patch.owner;
    if (owner) {
      const a = this.resolve(owner);
      if (!a) throw new HttpError(400, `no agent called "${owner}"`);
      if (a.role !== 'worker') throw new HttpError(400, 'tasks can only be assigned to worker agents');
      owner = a.id;
    }
    const nextOwner = owner === undefined ? before.owner : owner || undefined;
    const ownerChanged = nextOwner !== before.owner;
    const cancel = ownerChanged || (patch.status !== undefined && patch.status !== before.status && patch.status !== 'doing');
    const removedPending = cancel ? this.cancelQueuedTask(id) : false;
    const activeTurn = before.owner ? this.running.get(before.owner) : undefined;
    const stopActive = Boolean(activeTurn?.taskId === id && cancel);
    const task = this.taskCall(() => updateTask(id, {
      ...patch,
      ...(ownerChanged && patch.status === undefined ? { status: 'todo' as const } : {}),
      owner,
    }));
    this.emitTask(task, from, 'Task');
    if (from === 'user') this.queueUpdate(`kenz changed task ${task.id} to ${task.status}: ${task.title}`);
    if (stopActive && activeTurn) {
      activeTurn.controller.abort();
      if (task.owner && task.status === 'todo') activeTurn.done.then(() => this.startAssignedTask(task, from));
    } else if (task.owner && task.status === 'todo' && (ownerChanged || before.status !== 'todo' || removedPending)) {
      this.startAssignedTask(task, from);
    }
    return task;
  }

  removeTask(id: string): void {
    const task = getTask(id);
    if (!task || !deleteTask(id)) throw new HttpError(404, `no task ${id}`);
    this.cancelQueuedTask(id);
    const active = task.owner ? this.running.get(task.owner) : undefined;
    if (active?.taskId === id) active.controller.abort();
    this.emit(task.owner ?? 'team', { type: 'task', from: 'user', text: `Deleted ${task.id}: ${task.title}`, data: { ...task, deleted: true } });
  }

  /** Move a worker's tasks along without anyone asking: doing while it works, review or blocked after. */
  private advanceTasks(agentId: string, from: TaskStatus[], to: TaskStatus): void {
    for (const t of listTasks()) {
      if (t.owner === agentId && from.includes(t.status)) this.emitTask(updateTask(t.id, { status: to }), 'system', 'Task');
    }
  }

  private advanceTask(taskId: string | undefined, agentId: string, from: TaskStatus[], to: TaskStatus): void {
    if (!taskId) return;
    const task = getTask(taskId);
    if (task?.owner === agentId && from.includes(task.status)) this.emitTask(updateTask(taskId, { status: to }), 'system', 'Task');
  }

  private cancelQueuedTask(taskId: string): boolean {
    const queuedBefore = this.queued.length;
    this.queued = this.queued.filter(turn => turn.taskId !== taskId);
    let removed = this.queued.length !== queuedBefore;
    for (const [agentId, messages] of this.inbox) {
      const kept = messages.filter(message => !message.startsWith(`[TASK ${taskId}]`));
      if (kept.length !== messages.length) { removed = true; this.inbox.set(agentId, kept); }
      if (!kept.length) this.inbox.delete(agentId);
    }
    if (removed) this.savePending();
    return removed;
  }

  /** Start a newly assigned worker task, or queue it behind the worker's current turn. */
  private startAssignedTask(task: Task, from: string): boolean {
    if (task.status !== 'todo' || !task.owner) return false;
    const worker = store.getAgent(task.owner);
    if (!worker || worker.role !== 'worker') return false;
    const feedback = task.note?.trim();
    const prompt = `[TASK ${task.id}] ${task.title}${feedback ? `\n[Task feedback/context]\n${feedback.slice(0, 2_000)}` : ''}`;
    if (!this.queueTurn(worker.id, prompt, from, task.id)) {
      this.emit(worker.id, { type: 'error', from: 'system', text: `Could not queue task ${task.id}: the turn queue is full; the task remains on the board` });
      return false;
    }
    this.pump();
    return true;
  }

  /** Bound saved messages per busy agent so a hung turn cannot grow memory or pending.json without limit. */
  private queueInbox(agentId: string, message: string): boolean {
    const current = this.inbox.get(agentId) ?? [];
    if (current.length >= MAX_INBOX_MESSAGES) return false;
    this.inbox.set(agentId, [...current, message.slice(0, MAX_INBOX_MESSAGE)]);
    return true;
  }

  /** Agents sharing a working directory must not edit it at the same time. */
  private workspaceBusy(cwd: string, kind: string): boolean {
    if (kind === 'mock') return false; // the mock adapter never runs commands in the working tree
    const path = this.canonicalCwd(cwd);
    return [...this.running.keys()].some(id => {
      const runningAgent = store.getAgent(id, true);
      if (!runningAgent || runningAgent.kind === 'mock') return false;
      const other = this.canonicalCwd(runningAgent.cwd);
      const rel = relative(path, other);
      const reverse = relative(other, path);
      const contains = (value: string) => value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
      return contains(rel) || contains(reverse);
    });
  }

  private canonicalCwd(cwd: string): string {
    const path = resolve(cwd);
    try { return realpathSync(path); } catch { return path; }
  }

  private queueTurn(agentId: string, prompt: string, from: string, taskId?: string): boolean {
    if (this.queued.length >= MAX_QUEUED_TURNS) return false;
    this.queued.push({ agentId, prompt, from, ...(taskId ? { taskId } : {}) });
    this.savePending();
    return true;
  }

  // ---------- turns ----------

  private startTurn(agentId: string, prompt: string, from = 'user', requestedTaskId?: string): boolean {
    if (this.stopping) return false; // shutting down: no new work
    if (this.removing.has(agentId)) return false;
    const agent = this.requireAgent(agentId);
    const taskId = requestedTaskId ?? prompt.match(/^\[TASK (t\d+)\]/)?.[1];
    const adapter = getAdapter(agent.kind);
    if (!adapter) {
      this.emit(agentId, { type: 'error', text: `Unknown adapter: ${agent.kind}` });
      this.setStatus(agentId, 'error', `unknown adapter ${agent.kind}`);
      return false;
    }
    // Never start a replacement while the previous CLI is still exiting; abort is asynchronous.
    const current = this.running.get(agentId);
    if (current) {
      if (!this.queueTurn(agentId, prompt, from, taskId)) {
        this.emit(agentId, { type: 'error', text: `Too many turns are waiting (${MAX_QUEUED_TURNS}); this one was not started: ${oneLine(prompt, 120)}` });
        return false;
      }
      this.emit(agentId, { type: 'message', from: 'system', text: `Queued until the current turn stops: ${oneLine(prompt, 120)}` });
      current.controller.abort();
      return true;
    }

    // Too many turns at once slow every agent down and burn tokens: queue the turn until a slot frees.
    // Dropping it instead would lose a task the coordinator just handed out (and leave it on the board
    // forever), which is the worst thing a harness can do with work.
    const workspaceBusy = this.workspaceBusy(agent.cwd, agent.kind);
    if (this.running.size >= maxConcurrentTurns() || workspaceBusy) {
      if (!this.queueTurn(agentId, prompt, from, taskId)) {
        this.emit(agentId, { type: 'error', text: `Too many turns are waiting (${MAX_QUEUED_TURNS}); this one was not started: ${oneLine(prompt, 120)}` });
        this.setStatus(agentId, 'idle', 'idle');
        return false;
      }
      const waiting = this.queued.length;
      this.emit(agentId, {
        type: 'message', from: 'system',
        text: workspaceBusy
          ? `Queued: another agent is using this working directory, so this one waits (${waiting} waiting): ${oneLine(prompt, 120)}`
          : `Queued: ${maxConcurrentTurns()} turns are already running, so this one waits (${waiting} waiting): ${oneLine(prompt, 120)}`,
      });
      this.setStatus(agentId, 'idle', `queued (${waiting} waiting for a turn slot)`);
      return true;
    }

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
    // Persist the attempt before starting the worker so a restart does not reset the retry budget.
    if (agent.role === 'worker' && taskId) {
      const task = getTask(taskId);
      // A queued task may be manually moved to "doing" before its worker gets a turn slot.
      // Count it here too: attempts tracks actual worker starts, not board status transitions.
      if (task?.owner === agentId && ['todo', 'doing', 'review'].includes(task.status)) {
        this.emitTask(startTaskAttempt(taskId), 'system', 'Task');
      }
    }

    // The agent has to learn what came of the commands it wrote last time.
    const query = prompt;
    const results = this.takeCommandResults(agentId);
    if (results.length) {
      prompt = `[COMMAND RESULTS] What came of your last commands:\n${results.map(r => `- ${r}`).join('\n')}\n[END COMMAND RESULTS]\n\n${prompt}`;
    }
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

    // A turn that never ends must not hold the office hostage: after the timeout it is stopped,
    // the agent is marked as failed and its task is blocked.
    const timeout = turnTimeoutMs();
    const timer = timeout > 0 ? setTimeout(() => this.onTurnTimeout(agentId, controller), timeout) : undefined;
    timer?.unref();

    const done = (async () => {
      let failure: string | undefined;
      try {
        // Workers and the coordinator see the team brief, shared notes and related findings of other agents.
        if (agent.role !== 'ceo') {
          const shared = await sharedContextBlock(agent, query);
          if (shared) prompt = `${shared}\n\n${prompt}`;
        }
        if (signal.aborted) throw new Error('interrupted');
        await adapter.send(ctx, prompt);
      } catch (err: any) {
        failure = err?.message || String(err);
      }
      if (timer) clearTimeout(timer);
      const current = this.running.get(agentId);
      if (current && current.controller !== controller) return; // superseded by a newer turn
      if (!current && signal.aborted) return; // interrupted, and already marked as stopped
      this.running.delete(agentId);
      if (!store.getAgent(agentId)) return; // removed meanwhile

      if (signal.aborted) {
        if (current?.timedOut) this.setStatus(agentId, 'error', `error: ${current.timeoutMessage ?? 'turn timed out'}`);
        else this.setStatus(agentId, 'stopped', 'interrupted');
      } else if (failure) {
        this.emit(agentId, { type: 'error', text: failure });
        this.setStatus(agentId, 'error', `error: ${oneLine(failure, 80)}`);
      } else {
        this.setStatus(agentId, 'idle', 'idle');
      }
      this.onTurnEnd(agentId, signal.aborted, failure, current?.taskId);
      this.pump(); // a slot just freed: whatever was waiting can start now
      this.savePending();
    })();

    // The journal keeps the instruction as asked for (`query`), not with the context blocks added below:
    // a restored turn goes through this same path again and would otherwise get them twice.
    this.running.set(agentId, { controller, done, prompt: query, from, startedAt: Date.now(), ...(taskId ? { taskId } : {}) });
    this.savePending();
    return true;
  }

  /** A turn ran for too long: stop it, say so, and block the task it was working on. */
  private onTurnTimeout(agentId: string, controller: AbortController): void {
    const agent = store.getAgent(agentId);
    const turn = this.running.get(agentId);
    if (!agent || !turn || turn.controller !== controller || turn.timedOut) return;
    turn.timedOut = true;
    this.lastTurnEnd.set(agentId, Date.now());
    const ms = turnTimeoutMs();
    const span = ms < 60_000
      ? `${Math.max(1, Math.round(ms / 1000))} second${Math.round(ms / 1000) === 1 ? '' : 's'}`
      : `${Math.max(1, Math.round(ms / 60_000))} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`;
    const msg = `the turn ran for more than ${span} and was stopped`;
    turn.timeoutMessage = msg;
    controller.abort();
    this.emit(agentId, { type: 'error', from: 'system', text: msg });
    // Keep the turn registered while the child process group exits. That keeps its workspace
    // reserved and prevents a replacement from writing beside a CLI that ignored the timeout.
    this.setStatus(agentId, 'working', 'stopping after timeout…');
    const task = turn.taskId ? getTask(turn.taskId) : undefined;
    if (task?.owner === agentId && task.status === 'doing') {
      this.emitTask(updateTask(task.id, {
        status: 'blocked',
        note: appendTaskNote(task.note, `Task timed out on attempt ${task.attempts} after ${span}; reopen it to retry manually.`),
      }), 'system', 'Task');
    }
    this.queueUpdate(`${agent.name} (${agent.id}) timed out after ${span}`);
    // The instructions queued behind that turn will never run now: say so instead of keeping them
    // (or, worse, starting them straight after a timeout) and give the free slot to someone else.
    this.dropPending(agentId, 'the turn timed out');
  }

  /**
   * Start queued turns while there is room, oldest first. Called whenever a turn ends, times out or is
   * cancelled. A queued turn for an agent that got another turn meanwhile becomes that agent's inbox.
   */
  private pump(): void {
    if (this.pumpPaused) return;
    let changed = false;
    while (!this.stopping && this.queued.length && this.running.size < maxConcurrentTurns()) {
      const index = this.queued.findIndex(next => {
        if (this.removing.has(next.agentId)) return true;
        const agent = store.getAgent(next.agentId);
        if (!agent) return true;
        if (this.running.has(next.agentId)) {
          if (next.taskId) return false; // task assignments keep their identity and wait for a fresh turn
          return (this.inbox.get(next.agentId)?.length ?? 0) < MAX_INBOX_MESSAGES;
        }
        return !this.workspaceBusy(agent.cwd, agent.kind);
      });
      if (index < 0) break;
      const [next] = this.queued.splice(index, 1);
      changed = true;
      if (this.removing.has(next.agentId)) continue;
      if (!store.getAgent(next.agentId)) continue; // the agent left the office meanwhile
      if (this.running.has(next.agentId)) {
        this.queueInbox(next.agentId, next.prompt);
        continue;
      }
      this.startTurn(next.agentId, next.prompt, next.from, next.taskId);
    }
    if (changed) this.savePending();
    // Approved requests that couldn't enter a full queue remain durable and are retried here.
    this.recoverApprovedPermissions();
  }

  /**
   * Instructions that can no longer run (the agent timed out): name them instead of forgetting them,
   * so the coordinator and the task board do not silently lose the work.
   */
  private dropPending(agentId: string, why: string): void {
    const pending = [...(this.inbox.get(agentId) ?? [])];
    this.inbox.delete(agentId);
    const kept: QueuedTurn[] = [];
    for (const q of this.queued) {
      if (q.agentId !== agentId) { kept.push(q); continue; }
      pending.push(q.prompt);
      if (q.taskId) {
        const task = getTask(q.taskId);
        if (task?.owner === agentId && task.status === 'todo') {
          this.emitTask(updateTask(task.id, { status: 'blocked', note: `Not started because ${why}; reopen to retry.` }), 'system', 'Task');
        }
      }
    }
    this.queued = kept;
    this.savePending();
    if (!pending.length) return;
    const text = `${pending.length} instruction(s) were not run (${why}): ${pending.map(p => `"${oneLine(p, 120)}"`).join(', ')}`;
    this.emit(agentId, { type: 'error', from: 'system', text });
    this.queueUpdate(text);
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
    // SIGINT, then SIGTERM, then SIGKILL: wait long enough for all three.
    let finished = false;
    await Promise.race([turn.done.then(() => { finished = true; }), new Promise(r => { timer = setTimeout(r, KILL_GRACE_MS * 2 + 2000); })]);
    clearTimeout(timer);
    if (!finished && this.running.get(agentId) === turn) {
      // Keep the worker and its workspace occupied until the process group is actually gone.
      this.emit(agentId, { type: 'error', text: 'turn did not stop within the grace period; it remains tracked until the CLI exits' });
      this.setStatus(agentId, 'working', 'waiting for the interrupted CLI to exit…');
      this.savePending();
    }
    if (turn.taskId) {
      const task = getTask(turn.taskId);
      const nextTurn = this.running.get(agentId);
      if (finished && task?.owner === agentId && task.status === 'doing' && nextTurn?.taskId !== turn.taskId) {
        this.emitTask(updateTask(task.id, { status: 'todo', note: 'Interrupted before completion; the worker can continue on the next turn.' }), 'system', 'Task');
      }
    }
  }

  /** Interrupt if busy, then start a new turn (resuming the native session) with `text`. */
  async steerAgent(agentId: string, text: string, from = 'user'): Promise<AgentEvent> {
    if (!text) throw new HttpError(400, 'text is required');
    if (this.removing.has(agentId)) throw new HttpError(409, 'agent is being removed');
    const agent = this.requireAgent(agentId);
    const event = this.emit(agentId, { type: 'steer', from, text });

    const coordinator = this.findRole('coordinator');
    if (agent.role === 'worker' && from !== coordinator?.id) {
      const who = from === 'user' ? 'kenz' : (store.getAgent(from)?.name ?? from);
      this.queueUpdate(`${who} steered ${agent.name} (${agent.id}): "${oneLine(text, 200)}"`);
    }

    const taskId = this.running.get(agentId)?.taskId;
    const sequence = (this.steerSequence.get(agentId) ?? 0) + 1;
    this.steerSequence.set(agentId, sequence);
    this.pumpPaused++;
    try {
      if (this.running.has(agentId)) await this.interruptAgent(agentId);
      if (this.steerSequence.get(agentId) !== sequence || this.removing.has(agentId)) return event;
      this.startTurn(agentId, text, from, taskId);
      return event;
    } finally {
      this.pumpPaused--;
      if (!this.pumpPaused) this.pump();
    }
  }

  /**
   * Abort every running turn (server shutdown). No queued or follow-up turn may start meanwhile, but
   * nothing is forgotten either: the running turns and the queue stay in the journal for the next server.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (!this.stoppedTurns.length) {
      this.stoppedTurns = [...this.running.entries()].filter(([, turn]) => !turn.timedOut).map(([agentId, turn]) => ({
        agentId, prompt: turn.prompt, from: turn.from, startedAt: turn.startedAt, ...(turn.taskId ? { taskId: turn.taskId } : {}),
      }));
    }
    this.savePending(); // before the turns are aborted: their done handlers must not erase the journal
    const turns = [...this.running.entries()];
    await Promise.all(turns.map(([id]) => this.interruptAgent(id).catch(() => {})));
    // Keep shutdown (and the data-folder lock) open until every adapter confirms its process group
    // has exited. Otherwise a new server can start while an old CLI is still editing the workspace.
    await Promise.all(turns.map(([, turn]) => turn.done));
    if (this.updateTimer) clearTimeout(this.updateTimer);
    for (const pending of this.pendingCeoRequests.values()) if (pending.timer) clearTimeout(pending.timer);
    this.pendingCeoRequests.clear();
  }

  /** Stop every turn and remove the live workspace state for a clean first launch. */
  async resetWorkspace(): Promise<void> {
    await this.shutdown();
    this.pendingUpdates = [];
    this.inbox.clear();
    this.queued = [];
    this.briefed.clear();
    for (const agent of store.getAgents()) {
      store.removeAgent(agent.id);
    }
    store.reset();
    this.stoppedTurns = [];
    clearPendingWork();
    this.stopping = false; // the office is empty again and may take new work
  }

  // ---------- work in flight ----------

  /**
   * Write what is running, queued or waiting to $AGENTIX_HOME/pending.json. Every turn start and end
   * and every queue/inbox change does this, so even a killed process leaves its work on disk.
   */
  private savePending(): void {
    const interrupted: PendingTurn[] = this.stopping
      ? this.stoppedTurns
      : [...this.running.entries()].filter(([, turn]) => !turn.timedOut).map(([agentId, turn]) => ({
        agentId, prompt: turn.prompt, from: turn.from, startedAt: turn.startedAt, ...(turn.taskId ? { taskId: turn.taskId } : {}),
      }));
    const inbox: Record<string, string[]> = {};
    for (const [agentId, messages] of this.inbox) if (messages.length) inbox[agentId] = messages;
    const commandResults: Record<string, string[]> = {};
    for (const [agentId, lines] of this.commandResults) if (lines.length) commandResults[agentId] = lines.slice(-50);
    try {
      writePendingWork({
        interrupted: interrupted.map(t => ({ ...t })),
        queued: this.queued.map(q => ({ ...q })),
        inbox,
        commandResults,
      });
    } catch (err: any) {
      // A full or read-only home must not break the turn that is starting.
      if (!this.warnedPending) {
        this.warnedPending = true;
        console.error(`agentix: cannot save the work in flight (${err?.message ?? err}); a restart would lose it`);
      }
    }
  }

  /**
   * Offer the work a previous server was running, had queued or was holding again. Called once at
   * startup, after the CLIs the dead server left behind are stopped. Returns how many turns were re-offered.
   */
  resumePendingTurns(): number {
    if (this.resumed) return 0;
    this.resumed = true;
    const work = readPendingWork();
    if (!work) return 0;
    this.stoppedTurns = [];
    let dropped = 0;
    // The interrupted turns come first, then the ones that were queued behind them, in order.
    const restored = [
      ...work.interrupted.map(turn => ({ turn, wasRunning: true })),
      ...work.queued.map(turn => ({ turn, wasRunning: false })),
    ];
    for (const { turn, wasRunning } of restored) {
      if (!store.getAgent(turn.agentId)) { dropped++; continue; } // that agent was removed meanwhile
      this.emit(turn.agentId, {
        type: 'message', from: 'system',
        text: wasRunning
          ? `The server restarted while this agent was working; its turn is offered again: ${oneLine(withoutRestartNote(turn.prompt), 200)}`
          : `The server restarted before this waiting turn could start; it runs now: ${oneLine(withoutRestartNote(turn.prompt), 200)}`,
      });
      this.queued.push({
        agentId: turn.agentId,
        prompt: wasRunning ? interruptedTurnPrompt(turn.prompt) : turn.prompt,
        from: turn.from,
        ...(turn.taskId ? { taskId: turn.taskId } : {}),
      });
    }
    for (const [agentId, messages] of Object.entries(work.inbox)) {
      if (!messages.length || !store.getAgent(agentId)) continue;
      for (const message of messages) this.queueInbox(agentId, message);
      this.emit(agentId, {
        type: 'message', from: 'system',
        text: `The server restarted; ${messages.length} waiting message(s) are delivered now`,
      });
    }
    // The agent still learns what came of the commands it wrote before the restart.
    for (const [agentId, lines] of Object.entries(work.commandResults)) {
      if (!lines.length || !store.getAgent(agentId)) continue;
      this.commandResults.set(agentId, [...(this.commandResults.get(agentId) ?? []), ...lines]);
    }
    // Say what this server took over before starting anything, so a crash halfway through loses nothing.
    this.savePending();
    this.pump();
    // An idle agent with a waiting message starts a turn with it, the same rule a message sent after
    // a turn ends follows.
    for (const [agentId, messages] of [...this.inbox]) {
      if (!messages.length || this.running.has(agentId)) continue;
      this.inbox.delete(agentId);
      this.startTurn(agentId, messages.join('\n\n'), 'system');
    }
    this.savePending();
    if (dropped) console.log(`agentix: dropped ${dropped} saved turn(s) for agents that were removed`);
    return restored.length - dropped;
  }

  // ---------- coordinator updates ----------

  private findRole(role: Role): Agent | undefined {
    return store.getAgents().find(a => a.role === role);
  }

  private onTurnEnd(agentId: string, aborted: boolean, failure?: string, taskId?: string): void {
    this.lastTurnEnd.set(agentId, Date.now());
    const agent = store.getAgent(agentId);
    if (!agent) return;
    const waiting = this.inbox.get(agentId);
    // A replacement steer or an approval can arrive while an uncooperative CLI
    // is still exiting. Once that process is gone, deliver the waiting message
    // even though the old turn ended by aborting.
    if (waiting?.length) {
      this.inbox.delete(agentId);
      this.startTurn(agentId, waiting.join('\n\n'), 'system');
    }
    // A command that failed while the agent was working: it has to hear about it, in a turn of its own.
    if (this.commandResults.get(agentId)?.length) this.scheduleResultTurn(agentId);
    else this.resultTurns.set(agentId, 0);
    if (agent.role === 'coordinator') {
      // Updates that arrived while the coordinator was busy go out now.
      if (this.pendingUpdates.length) this.scheduleFlush();
      return;
    }
    if (agent.role !== 'worker') return;
    if (aborted) {
      if (taskId) {
        const task = getTask(taskId);
        const replacementQueued = this.queued.some(turn => turn.agentId === agentId && turn.taskId === taskId);
        const replacementRunning = this.running.get(agentId)?.taskId === taskId;
        if (task?.owner === agentId && task.status === 'doing' && !replacementQueued && !replacementRunning) {
          this.emitTask(updateTask(taskId, { status: 'todo', note: 'Interrupted before completion; the worker can continue on the next turn.' }), 'system', 'Task');
        }
      }
      return; // steers/stops already produced their own update
    }
    if (failure) {
      const task = taskId ? getTask(taskId) : undefined;
      if (task?.owner === agentId && task.status === 'doing'
        && task.attempts <= MAX_AUTOMATIC_TASK_RETRIES && isTransientTaskFailure(failure)) {
        const retry = updateTask(task.id, {
          status: 'todo',
          note: appendTaskNote(task.note, `Transient failure on attempt ${task.attempts}; retrying automatically once: ${oneLine(failure, 180)}`),
        });
        this.emitTask(retry, 'system', 'Task');
        if (this.startAssignedTask(retry, 'system')) {
          this.queueUpdate(`${agent.name} (${agent.id}) hit a transient failure on ${task.id}; automatically retrying once.`);
        } else {
          const blocked = updateTask(task.id, {
            status: 'blocked',
            note: appendTaskNote(task.note, `Automatic retry could not be queued after a transient failure: ${oneLine(failure, 180)}. Reopen to retry manually.`),
          });
          this.emitTask(blocked, 'system', 'Task');
          this.queueUpdate(`${agent.name} (${agent.id}) could not queue the automatic retry for ${task.id}; it is blocked for review.`);
        }
        return;
      }
      if (task?.owner === agentId && task.status === 'doing') {
        this.emitTask(updateTask(task.id, {
          status: 'blocked',
          note: appendTaskNote(task.note, `Worker failed on attempt ${task.attempts}: ${oneLine(failure, 300)}`),
        }), 'system', 'Task');
      } else this.advanceTask(taskId, agentId, ['doing'], 'blocked');
      this.queueUpdate(`${agent.name} (${agent.id}) failed: ${oneLine(failure, 200)}`);
    } else {
      const task = taskId ? getTask(taskId) : undefined;
      if (task?.owner === agentId && task.status === 'doing') {
        this.emitTask(updateTask(task.id, {
          status: 'review',
          ...(task.attempts > 1 ? { note: appendTaskNote(task.note, `Worker completed successfully on attempt ${task.attempts}; ready for review.`) } : {}),
        }), 'system', 'Task');
      } else this.advanceTask(taskId, agentId, ['doing'], 'review');
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

  // ---------- command results ----------

  /** Remember what came of a command, to tell the agent at the start of its next turn. */
  private addCommandResult(agentId: string, line: string): void {
    const results = this.commandResults.get(agentId) ?? [];
    results.push(line);
    this.commandResults.set(agentId, results);
    this.savePending();
  }

  private takeCommandResults(agentId: string): string[] {
    const results = this.commandResults.get(agentId);
    if (!results?.length) return [];
    this.commandResults.delete(agentId);
    this.savePending();
    return results;
  }

  /** Tell the agent that wrote a command what came of it: in the transcript and in its next turn. */
  private reportCommand(source: Agent, c: Command, result: string, error?: string): void {
    const line = error ? `${c.line}: ${oneLine(error, 200)}` : result;
    this.addCommandResult(source.id, line);
    if (error) {
      this.emit(source.id, { type: 'error', from: 'system', text: line });
      this.scheduleResultTurn(source.id);
    } else {
      this.emit(source.id, { type: 'message', from: 'system', text: line });
    }
  }

  /**
   * An agent whose command failed has to hear about it, even when nothing else would start a
   * turn for it. Only a few turns in a row, so a command that keeps failing cannot loop.
   */
  private scheduleResultTurn(agentId: string): void {
    if (this.running.has(agentId)) return; // the running turn ends with the results in front of it
    const agent = store.getAgent(agentId);
    if (!agent) return;
    const n = this.resultTurns.get(agentId) ?? 0;
    if (n >= MAX_RESULT_TURNS) return;
    this.resultTurns.set(agentId, n + 1);
    this.startTurn(agentId, '[AGENTIX] One of your commands did not go through: see [COMMAND RESULTS].', 'system');
  }

  /** Workers can update their own tasks and ask the coordinator; leads can run team commands. */
  private runCommands(sourceId: string, text: string): void {
    const source = store.getAgent(sourceId);
    if (!source) return;
    const parsed = parseCommands(text);
    for (const c of parsed.commands) {
      if (c.op !== 'remember') continue;
      const note = addNote(c.text, source.id);
      if (note) {
        this.emit(sourceId, { type: 'message', from: 'system', text: `Saved to shared context: ${oneLine(c.text, 200)}`, data: { note } });
        this.addCommandResult(sourceId, `${c.line}: saved to shared context`);
      }
    }
    if (source.role === 'worker') {
      // A worker may move its own tasks (e.g. "@@task t3 status=done").
      for (const c of parsed.commands) {
        if (c.op === 'tell') {
          const coordinator = this.findRole('coordinator');
          const isPermissionRequest = /\bPERMISSION REQUEST\s*:/i.test(c.text);
          const isCoordinator = [coordinator?.id, coordinator?.name.toLowerCase(), 'coordinator']
            .filter((value): value is string => Boolean(value)).includes(c.target.toLowerCase());
          if (!isCoordinator) {
            const msg = `${c.line}: workers may only message the coordinator`;
            this.emit(sourceId, { type: 'error', from: 'system', text: msg });
            this.addCommandResult(sourceId, msg);
            continue;
          }
          if (isPermissionRequest) {
            const taskId = this.running.get(sourceId)?.taskId;
            let request: PermissionRequest;
            try { request = createPermissionRequest({ workerId: sourceId, taskId, request: c.text }); }
            catch (err: any) {
              this.advanceTask(taskId, sourceId, ['doing'], 'blocked');
              this.running.get(sourceId)?.controller.abort();
              this.emit(sourceId, { type: 'error', from: 'system', text: `Permission request could not be saved (${err?.message ?? err}); the task is paused and needs human review.` });
              continue;
            }
            this.advanceTask(taskId, sourceId, ['doing'], 'blocked');
            // Persist first, then stop the current CLI turn; a decision resumes it as a fresh turn.
            this.running.get(sourceId)?.controller.abort();
            if (coordinator && getSettings().coordinatorMode !== 'human') {
              try {
                this.tellAgent(source, coordinator, `[PERMISSION REQUEST ${request.id}] from ${source.name} (${source.id})${taskId ? ` on task ${taskId}` : ''}:\n${c.text}`);
                this.emit(sourceId, { type: 'message', from: 'system', text: `Task paused; permission request ${request.id} sent to ${coordinator.name}.` });
              } catch (err: any) {
                this.emit(sourceId, { type: 'message', from: 'system', text: `Task paused; request ${request.id} is saved, but the coordinator could not receive it (${err?.message ?? err}). Review it on the Tasks page.` });
              }
            } else {
              const reason = coordinator ? 'coordinator mode is set to human' : 'no coordinator agent is available';
              this.emit(sourceId, { type: 'message', from: 'system', text: `Task paused; ${reason}. Permission request ${request.id} is saved for human review on the Tasks page.` });
            }
            continue;
          }
          queueMicrotask(() => this.runCommand(source, c)
            .then(result => this.reportCommand(source, c, result))
            .catch(err => this.reportCommand(source, c, '', err?.message ?? String(err))));
          continue;
        }
        if (c.op !== 'task' || !c.id) continue;
        const t = getTask(c.id);
        if (!t || t.owner !== source.id) {
          const msg = `${c.line}: not one of your tasks`;
          this.emit(sourceId, { type: 'error', from: 'system', text: msg });
          this.addCommandResult(sourceId, msg);
          this.scheduleResultTurn(sourceId);
          continue;
        }
        try {
          this.editTask(c.id, { status: c.opts.status as TaskStatus | undefined, ...(c.text ? { note: c.text } : {}) }, source.id);
          this.addCommandResult(sourceId, `${c.line}: done`);
        } catch (err: any) {
          const msg = `${c.line}: ${err?.message ?? err}`;
          this.emit(sourceId, { type: 'error', from: 'system', text: msg });
          this.addCommandResult(sourceId, msg);
          this.scheduleResultTurn(sourceId);
        }
      }
      return;
    }
    const commands = parsed.commands.filter(c => c.op !== 'remember');
    const errors = parsed.errors;
    const fail = (msg: string) => this.emit(sourceId, { type: 'error', from: 'system', text: msg });
    for (const e of errors) {
      fail(e);
      // A misspelled verb used to be ignored: the agent has to learn that it did nothing.
      this.addCommandResult(sourceId, e);
    }
    if (!commands.length) {
      if (errors.length) this.scheduleResultTurn(sourceId);
      return;
    }
    if (source.role === 'coordinator' && getSettings().coordinatorMode === 'human') {
      const msg = `Coordinator mode is "human", so ${commands.length} command(s) were not run`;
      fail(msg);
      this.addCommandResult(sourceId, msg);
      this.scheduleResultTurn(sourceId);
      return;
    }
    for (const c of commands) {
      // Run each command on its own tick so a spawn/steer never re-enters the turn that produced it.
      queueMicrotask(() => this.runCommand(source, c)
        .then(result => this.reportCommand(source, c, result))
        .catch(err => this.reportCommand(source, c, '', err?.message ?? String(err))));
    }
  }

  private async runCommand(source: Agent, c: Command): Promise<string> {
    if (source.role === 'ceo') {
      // The CEO talks to the coordinator and nobody else.
      if (c.op !== 'tell' || !['coordinator', this.findRole('coordinator')?.id, this.findRole('coordinator')?.name.toLowerCase()].includes(c.target.toLowerCase())) {
        throw new Error('the CEO can only "@@tell coordinator :: <message>"');
      }
      const coordinator = this.findRole('coordinator');
      if (!coordinator || getSettings().coordinatorMode === 'human') {
        this.emit(source.id, { type: 'message', from: 'system', text: `No coordinator agent is running; kenz is coordinating. Message kept here: ${c.text}` });
        return 'there is no coordinator agent to tell; kenz is coordinating';
      }
      this.emit(coordinator.id, { type: 'message', from: source.id, text: c.text });
      this.pendingUpdates.push(`CEO ${source.name} says: "${c.text}"`);
      this.trackCeoRequest(source, coordinator, c.text);
      this.scheduleFlush();
      return `told the coordinator (${coordinator.name})`;
    }

    switch (c.op) {
      case 'remember': return 'saved to shared context'; // handled in runCommands
      case 'approve':
      case 'decline': {
        if (source.role !== 'coordinator') throw new Error('only the coordinator can decide permission requests');
        const decision = c.op === 'approve' ? 'approved' : 'declined';
        const request = this.decidePermission(c.id, decision, source.id, c.text);
        return `${decision} permission request ${request.id}`;
      }
      case 'task': {
        const status = c.opts.status as TaskStatus | undefined;
        if (status && !TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_STATUSES.join(', ')}`);
        if (c.id) {
          this.editTask(c.id, { status, ...(c.opts.owner ? { owner: c.opts.owner } : {}), ...(c.text ? { note: c.text } : {}) }, source.id);
          return `task ${c.id} is now ${status ?? 'updated'}`;
        }
        const task = this.addTask({ title: c.text, owner: c.opts.owner, status }, source.id);
        this.startAssignedTask(task, source.id);
        return `created task ${task.id}`;
      }
      case 'spawn': {
        const o = c.opts;
        const role = (o.role as Role | undefined) ?? 'worker';
        if (role !== 'worker') throw new Error('the coordinator can only spawn workers');
        const avatarId = o.avatar === undefined || o.avatar === 'random' ? 'random' : Number(o.avatar);
        const model = cleanModel(o.model);
        if (model) {
          const modelError = await unavailableModelError(o.kind, model);
          if (modelError) throw new Error(modelError);
        }
        // The task goes on the board before the worker starts, so its first turn moves it to doing.
        const created = await this.createAgent(o.kind, { name: o.name, avatarId, cwd: o.cwd, from: source.id, model });
        if (c.text) {
          const task = this.addTask({ title: oneLine(c.text, 140), owner: created.id, status: 'todo' }, source.id);
          this.emit(created.id, { type: 'message', from: source.id, text: c.text });
          this.startTurn(created.id, c.text, source.id, task.id);
        }
        return `spawned ${created.name} (${created.id})`;
      }
      case 'steer': {
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.id === source.id) throw new Error('an agent cannot steer itself');
        // Older coordinator turns sometimes used @@steer for a CEO report. Treat it as
        // @@tell so that a harmless wording mismatch does not lose the delegation update
        // or interrupt the CEO's current turn.
        if (target.role === 'ceo') {
          this.tellAgent(source, target, c.text);
          return `told the CEO (${target.name})`;
        }
        await this.steerAgent(target.id, c.text, source.id);
        return `steered ${target.name} (${target.id})`;
      }
      case 'stop': {
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.role !== 'worker') throw new Error('the coordinator can only stop workers');
        this.emit(target.id, { type: 'message', from: source.id, text: 'stop' });
        await this.interruptAgent(target.id);
        return `stopped ${target.name} (${target.id})`;
      }
      case 'tell': {
        // A message, not an instruction: it never cuts the target's current turn short. Sent to a
        // busy agent it waits in its inbox, so "tell a working worker something" is not an error.
        const target = this.resolve(c.target);
        if (!target) throw new Error(`no agent called "${c.target}"`);
        if (target.id === source.id) throw new Error('an agent cannot message itself');
        this.tellAgent(source, target, c.text);
        return `told ${target.name} (${target.id})`;
      }
    }
  }

  /**
   * Send a message from one agent to another without interrupting it. A busy target reads it at the
   * start of its next turn (its inbox); an idle one starts a turn with it.
   */
  private tellAgent(source: Agent, target: Agent, text: string): void {
    const runningTurn = this.running.get(target.id);
    const waitsForExit = Boolean(runningTurn?.controller.signal.aborted);
    if (runningTurn && waitsForExit && this.queued.length >= MAX_QUEUED_TURNS) {
      throw new HttpError(429, `${target.name} is stopping and the turn queue is full; try again shortly`);
    }
    if (runningTurn && !waitsForExit && (this.inbox.get(target.id)?.length ?? 0) >= MAX_INBOX_MESSAGES) {
      throw new HttpError(429, `${target.name}'s inbox is full; try again after its current turn`);
    }
    if (target.role === 'ceo') this.clearCeoRequest(target.id, source.id);
    this.emit(target.id, { type: 'message', from: source.id, text });
    const msg = `[FROM ${source.role.toUpperCase()} ${source.name}]\n${text}`;
    if (runningTurn && waitsForExit) {
      this.queueTurn(target.id, msg, source.id);
    } else if (runningTurn) {
      this.queueInbox(target.id, msg);
      this.savePending();
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
      const last = store.getLatestAgentOutput(a.id);
      const out = last?.text ? `\n    last output: ${oneLine(last.text, 200)}` : '';
      return `- ${a.name} (${a.id}, ${a.kind}, ${a.role}): ${a.status} — ${a.activity}${out}`;
    }).join('\n') + tasks;
  }
}
