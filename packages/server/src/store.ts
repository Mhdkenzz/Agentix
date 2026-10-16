// Agentix — SQLite store (node:sqlite), with a JSON-file fallback behind the same interface
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { Agent, AgentEvent, Status } from '../../shared/src/types.ts';

/** Data directory: $AGENTIX_HOME, else ~/.agentix. Tests point this at a temp dir. */
export const AGENTIX_HOME = process.env.AGENTIX_HOME || join(homedir(), '.agentix');
const DB_PATH = join(AGENTIX_HOME, 'agentix.db');
const JSON_PATH = join(AGENTIX_HOME, 'agentix.json');

mkdirSync(AGENTIX_HOME, { recursive: true });

type NewEvent = Omit<AgentEvent, 'id' | 'ts' | 'agentId'>;

export interface IStore {
  getStoreType(): 'sqlite' | 'json';
  getAgents(): Agent[];
  getAgent(id: string): Agent | undefined;
  createAgent(agent: Agent): void;
  updateAgent(agent: Agent): void;
  setStatus(id: string, status: Status, activity: string): void;
  setNativeSessionId(id: string, sessionId: string): void;
  removeAgent(id: string): void;
  /** all events after `after`; with `limit`, only the latest `limit` of those */
  getEvents(after?: number, limit?: number): AgentEvent[];
  getAgentEvents(agentId: string, after?: number, limit?: number): AgentEvent[];
  appendEvent(event: NewEvent, agentId: string): AgentEvent;
  /** mark agents that were mid-turn when the server died; returns how many */
  resetBusyAgents(): number;
}

const BUSY: Status[] = ['starting', 'thinking', 'working'];

// ---------- SQLite ----------

function openSqlite(): IStore | null {
  let DatabaseSync: any;
  try {
    // Loaded lazily so Node versions without node:sqlite fall back to JSON.
    ({ DatabaseSync } = (process as any).getBuiltinModule('node:sqlite'));
  } catch {
    return null;
  }
  if (!DatabaseSync) return null;

  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
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
      sender TEXT,
      text TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_agent ON events(agentId, id);
  `);

  const toAgent = (r: any): Agent => ({
    id: r.id, name: r.name, kind: r.kind, role: r.role, avatarId: r.avatarId,
    cwd: r.cwd, status: r.status, activity: r.activity,
    ...(r.nativeSessionId ? { nativeSessionId: r.nativeSessionId } : {}),
    createdAt: r.createdAt,
  });
  const toEvent = (r: any): AgentEvent => ({
    id: r.id, agentId: r.agentId, type: r.type, ts: r.ts,
    ...(r.sender != null ? { from: r.sender } : {}),
    ...(r.text != null ? { text: r.text } : {}),
    ...(r.data != null ? { data: JSON.parse(r.data) } : {}),
  });

  const q = {
    agents: db.prepare('SELECT * FROM agents ORDER BY createdAt ASC'),
    agent: db.prepare('SELECT * FROM agents WHERE id = ?'),
    insertAgent: db.prepare(`INSERT INTO agents (id, name, kind, role, avatarId, cwd, status, activity, nativeSessionId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateAgent: db.prepare(`UPDATE agents SET name=?, kind=?, role=?, avatarId=?, cwd=?, status=?, activity=?, nativeSessionId=? WHERE id=?`),
    setStatus: db.prepare('UPDATE agents SET status=?, activity=? WHERE id=?'),
    setSession: db.prepare('UPDATE agents SET nativeSessionId=? WHERE id=?'),
    deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
    deleteEvents: db.prepare('DELETE FROM events WHERE agentId = ?'),
    events: db.prepare('SELECT * FROM (SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
    agentEvents: db.prepare('SELECT * FROM (SELECT * FROM events WHERE agentId = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
    insertEvent: db.prepare('INSERT INTO events (agentId, type, ts, sender, text, data) VALUES (?, ?, ?, ?, ?, ?)'),
    insertEventWithId: db.prepare('INSERT INTO events (id, agentId, type, ts, sender, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    resetBusy: db.prepare(`UPDATE agents SET status='idle', activity='idle (server restarted)' WHERE status IN (${BUSY.map(() => '?').join(',')})`),
    countAgents: db.prepare('SELECT COUNT(*) AS n FROM agents'),
  };

  const s: IStore = {
    getStoreType: () => 'sqlite',
    getAgents: () => q.agents.all().map(toAgent),
    getAgent: id => { const r = q.agent.get(id); return r ? toAgent(r) : undefined; },
    createAgent: a => {
      q.insertAgent.run(a.id, a.name, a.kind, a.role, a.avatarId, a.cwd, a.status, a.activity, a.nativeSessionId ?? null, a.createdAt);
    },
    updateAgent: a => {
      q.updateAgent.run(a.name, a.kind, a.role, a.avatarId, a.cwd, a.status, a.activity, a.nativeSessionId ?? null, a.id);
    },
    setStatus: (id, status, activity) => { q.setStatus.run(status, activity, id); },
    setNativeSessionId: (id, sid) => { q.setSession.run(sid, id); },
    removeAgent: id => { q.deleteAgent.run(id); q.deleteEvents.run(id); },
    getEvents: (after = 0, limit = -1) => q.events.all(after, limit).map(toEvent),
    getAgentEvents: (agentId, after = 0, limit = -1) => q.agentEvents.all(agentId, after, limit).map(toEvent),
    appendEvent: (e, agentId) => {
      const ts = Date.now();
      const r = q.insertEvent.run(agentId, e.type, ts, e.from ?? null, e.text ?? null, e.data !== undefined ? JSON.stringify(e.data) : null);
      return { ...e, id: Number(r.lastInsertRowid), ts, agentId };
    },
    resetBusyAgents: () => Number(q.resetBusy.run(...BUSY).changes),
  };

  // One-time import of the JSON store written by earlier versions.
  if (existsSync(JSON_PATH) && (q.countAgents.get() as any).n === 0) {
    try {
      const data = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
      db.exec('BEGIN');
      for (const a of data.agents ?? []) s.createAgent(a);
      for (const e of data.events ?? []) {
        q.insertEventWithId.run(e.id, e.agentId, e.type, e.ts, e.from ?? null, e.text ?? null, e.data !== undefined ? JSON.stringify(e.data) : null);
      }
      db.exec('COMMIT');
      renameSync(JSON_PATH, JSON_PATH + '.imported');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    }
  }

  return s;
}

// ---------- JSON fallback ----------

function openJson(): IStore {
  let agents: Agent[] = [];
  let events: AgentEvent[] = [];
  let nextEventId = 1;
  try {
    if (existsSync(JSON_PATH)) {
      const data = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
      agents = data.agents || [];
      events = data.events || [];
      nextEventId = data.nextEventId || events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    }
  } catch { /* fresh start */ }

  // Coalesce writes: an agent can emit dozens of events per second.
  let saveTimer: NodeJS.Timeout | undefined;
  const flush = () => {
    saveTimer = undefined;
    try { writeFileSync(JSON_PATH, JSON.stringify({ agents, events, nextEventId })); } catch { /* ignore */ }
  };
  const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 200); };
  process.on('exit', () => { if (saveTimer) { clearTimeout(saveTimer); flush(); } });

  const tail = (list: AgentEvent[], limit: number) => (limit < 0 ? list : limit === 0 ? [] : list.slice(-limit));
  const patch = (id: string, fields: Partial<Agent>) => {
    const a = agents.find(x => x.id === id);
    if (a) { Object.assign(a, fields); save(); }
  };

  return {
    getStoreType: () => 'json',
    getAgents: () => agents.map(a => ({ ...a })),
    getAgent: id => { const a = agents.find(x => x.id === id); return a ? { ...a } : undefined; },
    createAgent: a => { agents.push({ ...a }); save(); },
    updateAgent: a => patch(a.id, { ...a }),
    setStatus: (id, status, activity) => patch(id, { status, activity }),
    setNativeSessionId: (id, nativeSessionId) => patch(id, { nativeSessionId }),
    removeAgent: id => {
      agents = agents.filter(a => a.id !== id);
      events = events.filter(e => e.agentId !== id);
      save();
    },
    getEvents: (after = 0, limit = -1) => tail(events.filter(e => e.id > after), limit),
    getAgentEvents: (agentId, after = 0, limit = -1) => tail(events.filter(e => e.agentId === agentId && e.id > after), limit),
    appendEvent: (e, agentId) => {
      const full: AgentEvent = { ...e, id: nextEventId++, ts: Date.now(), agentId };
      events.push(full);
      save();
      return full;
    },
    resetBusyAgents: () => {
      let n = 0;
      for (const a of agents) if (BUSY.includes(a.status)) { a.status = 'idle'; a.activity = 'idle (server restarted)'; n++; }
      if (n) save();
      return n;
    },
  };
}

export const store: IStore = (process.env.AGENTIX_STORE !== 'json' && openSqlite()) || openJson();
