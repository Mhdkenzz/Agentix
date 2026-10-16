// Agentix — shared data model

export type AgentKind = 'mock' | 'codex' | 'opencode' | 'claude' | 'hermes' | 'pi';
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
}

export type EventType =
  | 'agent.created' | 'agent.updated' | 'agent.removed'
  | 'output'
  | 'tool'
  | 'status'
  | 'steer'
  | 'message'
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
