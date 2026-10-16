// Agentix — shared data model

export type AgentKind = 'mock' | 'codex' | 'opencode' | 'claude' | 'hermes' | 'pi' | 'gemini' | 'aider' | 'goose';
export type Role = 'ceo' | 'coordinator' | 'worker';
export type Status = 'starting' | 'idle' | 'thinking' | 'working' | 'waiting_input' | 'error' | 'stopped';

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  role: Role;
  avatarId: number;
  cwd: string;
  status: Status;
  activity: string;
  nativeSessionId?: string;
  createdAt: number;
  /** set when the agent was removed; its record and history are kept */
  archivedAt?: number;
  /** a worker working in its own git worktree and branch (cwd is inside `path`) */
  worktree?: Worktree;
  /** the model the CLI runs with (its own name for it); unset = the CLI's default */
  model?: string;
}

/** One model an agent CLI can run with, for the New agent picker. */
export interface ModelOption {
  /** what Agentix passes to the CLI's model flag */
  id: string;
  /** a friendlier name, when the CLI gives one */
  label?: string;
  /** provider or family, to group the list */
  group?: string;
  description?: string;
  /** reasoning levels the model takes (codex), picked as "<id>:<level>" */
  efforts?: string[];
  defaultEffort?: string;
}

export interface Worktree {
  /** top level of the repository the worker was started in */
  repo: string;
  /** the worktree folder, under $AGENTIX_HOME/worktrees */
  path: string;
  /** e.g. agentix/rook-a_12ab34 */
  branch: string;
  /** changes are counted from this commit (where the branch started, or its last merge) */
  base: string;
}

/** Token use of one turn (or a running total), as reported by the CLI. */
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** in US dollars, when the CLI reports it */
  cost?: number;
}

export type TaskStatus = 'todo' | 'doing' | 'review' | 'done' | 'blocked';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** agent id of the owner */
  owner?: string;
  /** who created it: 'user' or an agent id */
  by: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export type EventType =
  | 'agent.created' | 'agent.updated' | 'agent.removed'
  | 'output'
  | 'tool'
  | 'thinking'
  | 'status'
  | 'steer'
  | 'message'
  | 'session'   // new native session started; data.clear = true also hides earlier events in the UI
  | 'usage'     // tokens (and cost) of one turn; data is a Usage
  | 'task'      // a task-board task was created or changed; data is the Task
  | 'error';

export interface AgentEvent {
  id: number;
  agentId: string;
  type: EventType;
  ts: number;
  from?: string;
  text?: string;
  data?: unknown;
}

// Names pool for auto-generated agent names
export const NAMES = [
  'Nova', 'Atlas', 'Echo', 'Pixel', 'Rook',
  'Juno', 'Sable', 'Orbit', 'Vex', 'Kai',
  'Luna', 'Cipher', 'Blaze', 'Frost', 'Nimbus',
];

export const AVATAR_NAMES = [
  'Robot', 'Astronaut', 'Wizard', 'Ninja', 'Cat-person',
  'Hacker', 'Scientist', 'Pirate', 'Knight', 'Alien',
];
