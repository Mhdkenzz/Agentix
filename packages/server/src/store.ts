// Agentix — SQLite / JSON store
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Agent, AgentEvent } from '../../shared/src/types.ts';

const DB_PATH = join(homedir(), '.agentix', 'agentix.db');
const JSON_PATH = join(homedir(), '.agentix', 'agentix.json');

// Ensure directory exists
if (!existsSync(join(homedir(), '.agentix'))) {
  try {
    const { execSync } = await import('node:child_process');
    execSync(`mkdir -p ${join(homedir(), '.agentix')}`);
  } catch { /* best effort */ }
}

let useSqlite = false;
let sqlite: any = null;

// Try to use node:sqlite
try {
  const sqliteModule = await import('node:sqlite');
  const Database = sqliteModule.Database;
  sqlite = new Database(DB_PATH);
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL,
      avatarId INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      activity TEXT NOT NULL,
      nativeSessionId TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentId TEXT NOT NULL,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      from TEXT,
      text TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_agent_ts ON events(agentId, ts);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  `);
  useSqlite = true;
} catch {
  // Fall back to JSON store
  useSqlite = false;
}

// JSON store fallback
let jsonAgents: Agent[] = [];
let jsonEvents: AgentEvent[] = [];
let jsonNextEventId = 1;

function loadJsonStore() {
  try {
    if (existsSync(JSON_PATH)) {
      const data = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
      jsonAgents = data.agents || [];
      jsonEvents = data.events || [];
      jsonNextEventId = data.nextEventId || 1;
    }
  } catch { /* fresh start */ }
}

function saveJsonStore() {
  try {
    writeFileSync(JSON_PATH, JSON.stringify({
      agents: jsonAgents,
      events: jsonEvents,
      nextEventId: jsonNextEventId,
    }, null, 2));
  } catch { /* ignore */ }
}

loadJsonStore();

export interface IStore {
  agents: Agent[];
  getAgents(): Agent[];
  getAgent(id: string): Agent | undefined;
  createAgent(agent: Agent): void;
  updateAgent(agent: Agent): void;
  removeAgent(id: string): void;
  events: AgentEvent[];
  getEvents(after?: number): AgentEvent[];
  getAgentEvents(agentId: string, after?: number): AgentEvent[];
  appendEvent(event: Omit<AgentEvent, 'id' | 'ts' | 'agentId'>, agentId: string): AgentEvent;
  getNextEventId(): number;
  getStoreType(): 'sqlite' | 'json';
}

export const store: IStore = {
  agents: [],
  events: [],

  getStoreType(): 'sqlite' | 'json' {
    return useSqlite ? 'sqlite' : 'json';
  },

  getAgents(): Agent[] {
    if (useSqlite) {
      const rows = sqlite.exec('SELECT * FROM agents ORDER BY createdAt DESC');
      return (rows || []).map((r: any) => ({
        id: r.id, name: r.name, kind: r.kind, role: r.role,
        avatarId: r.avatarId, cwd: r.cwd, status: r.status,
        activity: r.activity, nativeSessionId: r.nativeSessionId,
        createdAt: r.createdAt,
      }));
    }
    return [...jsonAgents];
  },

  getAgent(id: string): Agent | undefined {
    if (useSqlite) {
      const rows = sqlite.exec('SELECT * FROM agents WHERE id = ?', id);
      const row = rows?.[0];
      if (!row) return undefined;
      return {
        id: row.id, name: row.name, kind: row.kind, role: row.role,
        avatarId: row.avatarId, cwd: row.cwd, status: row.status,
        activity: row.activity, nativeSessionId: row.nativeSessionId,
        createdAt: row.createdAt,
      };
    }
    return jsonAgents.find(a => a.id === id);
  },

  createAgent(agent: Agent): void {
    if (useSqlite) {
      sqlite.exec(`
        INSERT INTO agents (id, name, kind, role, avatarId, cwd, status, activity, nativeSessionId, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, agent.id, agent.name, agent.kind, agent.role, agent.avatarId, agent.cwd, agent.status, agent.activity, agent.nativeSessionId ?? null, agent.createdAt);
    } else {
      jsonAgents.push(agent);
      saveJsonStore();
    }
  },

  updateAgent(agent: Agent): void {
    if (useSqlite) {
      sqlite.exec(`
        UPDATE agents SET name=?, kind=?, role=?, avatarId=?, cwd=?, status=?, activity=?, nativeSessionId=?, createdAt=?
        WHERE id=?
      `, agent.name, agent.kind, agent.role, agent.avatarId, agent.cwd, agent.status, agent.activity, agent.nativeSessionId ?? null, agent.createdAt, agent.id);
    } else {
      const idx = jsonAgents.findIndex(a => a.id === agent.id);
      if (idx >= 0) {
        jsonAgents[idx] = agent;
        saveJsonStore();
      }
    }
  },

  removeAgent(id: string): void {
    if (useSqlite) {
      sqlite.exec('DELETE FROM agents WHERE id = ?', id);
      sqlite.exec('DELETE FROM events WHERE agentId = ?', id);
    } else {
      jsonAgents = jsonAgents.filter(a => a.id !== id);
      jsonEvents = jsonEvents.filter(e => e.agentId !== id);
      saveJsonStore();
    }
  },

  getEvents(after?: number): AgentEvent[] {
    if (useSqlite) {
      const rows = after !== undefined
        ? sqlite.exec('SELECT * FROM events WHERE id > ? ORDER BY id ASC', after)
        : sqlite.exec('SELECT * FROM events ORDER BY id ASC');
      return (rows || []).map((r: any) => ({
        id: r.id, agentId: r.agentId, type: r.type, ts: r.ts,
        from: r.from, text: r.text, data: r.data ? JSON.parse(r.data) : undefined,
      }));
    }
    return after !== undefined
      ? jsonEvents.filter(e => e.id > after)
      : [...jsonEvents];
  },

  getAgentEvents(agentId: string, after?: number): AgentEvent[] {
    if (useSqlite) {
      const rows = after !== undefined
        ? sqlite.exec('SELECT * FROM events WHERE agentId = ? AND id > ? ORDER BY id ASC', agentId, after)
        : sqlite.exec('SELECT * FROM events WHERE agentId = ? ORDER BY id ASC', agentId);
      return (rows || []).map((r: any) => ({
        id: r.id, agentId: r.agentId, type: r.type, ts: r.ts,
        from: r.from, text: r.text, data: r.data ? JSON.parse(r.data) : undefined,
      }));
    }
    return (after !== undefined
      ? jsonEvents.filter(e => e.agentId === agentId && e.id > after)
      : jsonEvents.filter(e => e.agentId === agentId)
    );
  },

  appendEvent(event: Omit<AgentEvent, 'id' | 'ts' | 'agentId'>, agentId: string): AgentEvent {
    const id = this.getNextEventId();
    const full: AgentEvent = {
      ...event,
      id,
      ts: Date.now(),
      agentId,
    };

    if (useSqlite) {
      sqlite.exec(`
        INSERT INTO events (agentId, type, ts, from, text, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `, agentId, event.type, full.ts, event.from ?? null, event.text ?? null, event.data ? JSON.stringify(event.data) : null);
    } else {
      jsonEvents.push(full);
      saveJsonStore();
    }

    return full;
  },

  getNextEventId(): number {
    if (useSqlite) {
      const row = sqlite.exec('SELECT MAX(id) as max_id FROM events');
      return (row?.[0]?.max_id || 0) + 1;
    }
    return jsonNextEventId++;
  },
};
