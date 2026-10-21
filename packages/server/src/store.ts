// Agentix — SQLite store (node:sqlite), with a JSON-file fallback behind the same interface
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import type { Agent, AgentEvent, Status, Usage } from '../../shared/src/types.ts';
import { withHistory } from './history.ts';

/** Data directory: $AGENTIX_HOME, else ~/.agentix. Tests point this at a temp dir. */
export const AGENTIX_HOME = process.env.AGENTIX_HOME || join(homedir(), '.agentix');

mkdirSync(AGENTIX_HOME, { recursive: true });

/** The database file (SQLite store). */
const dbPath = (home: string) => join(home, 'agentix.db');
/** The agents file (JSON fallback). */
const jsonPath = (home: string) => join(home, 'agentix.json');
/** The events file (JSON fallback): append-only, one event per line. */
const jsonEventsPath = (home: string) => join(home, 'agentix-events.jsonl');

type NewEvent = Omit<AgentEvent, 'id' | 'ts' | 'agentId'>;

export interface IStore {
  getStoreType(): 'sqlite' | 'json';
  /** live agents (not removed) */
  getAgents(): Agent[];
  /** every agent ever created, removed ones included (they have archivedAt) */
  getAllAgents(): Agent[];
  /** a live agent; with includeArchived, a removed one too */
  getAgent(id: string, includeArchived?: boolean): Agent | undefined;
  createAgent(agent: Agent): void;
  updateAgent(agent: Agent): void;
  setStatus(id: string, status: Status, activity: string): void;
  setNativeSessionId(id: string, sessionId: string): void;
  /** mark an agent removed but keep its record and every event */
  archiveAgent(id: string): void;
  /** delete an agent and its events for good (only for leftover mock agents) */
  removeAgent(id: string): void;
  /** remove all agents and events, including archived history */
  reset(): void;
  /** all events after `after`; with `limit`, only the latest `limit` of those */
  getEvents(after?: number, limit?: number): AgentEvent[];
  getAgentEvents(agentId: string, after?: number, limit?: number): AgentEvent[];
  appendEvent(event: NewEvent, agentId: string): AgentEvent;
  /** mark agents that were mid-turn when the server died; returns how many */
  resetBusyAgents(): number;
  /** newest first: events matching all given filters, with id < before */
  searchEvents(f: EventSearch): AgentEvent[];
  /** per agent: number of events and time of the latest one */
  eventStats(): { agentId: string; count: number; lastTs: number }[];
  /** per agent: summed 'usage' events since `since` (ms), and how many turns reported usage */
  usageTotals(since?: number): UsageTotal[];
  /** delete events older than `before` (ms), except the types in `keep`; returns how many */
  pruneEvents(before: number, keep: string[]): number;
}

export interface UsageTotal extends Usage { agentId: string; turns: number }

export interface EventSearch {
  q?: string;          // case-insensitive substring of the text
  agentId?: string;
  types?: string[];
  before?: number;     // event id, for paging backwards
  limit?: number;      // default 200
}

const BUSY: Status[] = ['starting', 'thinking', 'working'];

/** One JSON event per line, read back into events. A torn last line is skipped. */
function readEventLines(path: string): AgentEvent[] {
  let raw = '';
  try { raw = readFileSync(path, 'utf-8'); } catch { return []; }
  const out: AgentEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.id === 'number') out.push(e);
    } catch { /* a torn line (the server died mid-write) */ }
  }
  return out;
}

/** Write the whole events file (used when events are deleted, not appended). */
function writeEventLines(path: string, events: AgentEvent[]): void {
  try {
    writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  } catch { /* reported by the caller */ }
}

// ---------- SQLite ----------

function openSqlite(home: string): IStore | null {
  let DatabaseSync: any;
  try {
    // Loaded lazily so Node versions without node:sqlite fall back to JSON.
    ({ DatabaseSync } = (process as any).getBuiltinModule('node:sqlite'));
  } catch {
    return null;
  }
  if (!DatabaseSync) return null;

  const db = new DatabaseSync(dbPath(home));
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
      createdAt INTEGER NOT NULL,
      archivedAt INTEGER,
      worktree TEXT,
      model TEXT
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

  // Databases from before agents were archived instead of deleted.
  const columns = new Set(db.prepare('PRAGMA table_info(agents)').all().map((c: any) => c.name));
  if (!columns.has('archivedAt')) db.exec('ALTER TABLE agents ADD COLUMN archivedAt INTEGER');
  if (!columns.has('worktree')) db.exec('ALTER TABLE agents ADD COLUMN worktree TEXT');
  if (!columns.has('model')) db.exec('ALTER TABLE agents ADD COLUMN model TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts)');

  // Full-text search over the event text. FTS5 with the trigram tokenizer keeps the old
  // behaviour (case-insensitive substring, with % and _ literal) but finds rows through an
  // index instead of scanning the whole table. An SQLite build without FTS5 falls back to LIKE.
  // remove_diacritics 0 keeps it byte-for-byte equal to LIKE, which does not fold accents.
  let fts = false;
  try {
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name='events_fts'").get() as any;
    if (existing && !/remove_diacritics 0/.test(existing.sql || '')) {
      db.exec('DROP TABLE events_fts');
    }
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='events', content_rowid='id', tokenize='trigram remove_diacritics 0')`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE OF text ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
    const indexed = Number((db.prepare('SELECT COUNT(*) AS n FROM events_fts').get() as any).n);
    const total = Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n);
    // An index built for an older database is filled once, here.
    if (indexed === 0 && total > 0) db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
    fts = true;
  } catch { fts = false; }

  const toAgent = (r: any): Agent => ({
    id: r.id, name: r.name, kind: r.kind, role: r.role, avatarId: r.avatarId,
    cwd: r.cwd, status: r.status, activity: r.activity,
    ...(r.nativeSessionId ? { nativeSessionId: r.nativeSessionId } : {}),
    createdAt: r.createdAt,
    ...(r.archivedAt != null ? { archivedAt: r.archivedAt } : {}),
    ...(r.worktree ? { worktree: JSON.parse(r.worktree) } : {}),
    ...(r.model ? { model: r.model } : {}),
  });
  const toEvent = (r: any): AgentEvent => ({
    id: r.id, agentId: r.agentId, type: r.type, ts: r.ts,
    ...(r.sender != null ? { from: r.sender } : {}),
    ...(r.text != null ? { text: r.text } : {}),
    ...(r.data != null ? { data: JSON.parse(r.data) } : {}),
  });

  const q = {
    agents: db.prepare('SELECT * FROM agents WHERE archivedAt IS NULL ORDER BY createdAt ASC'),
    allAgents: db.prepare('SELECT * FROM agents ORDER BY createdAt ASC'),
    agent: db.prepare('SELECT * FROM agents WHERE id = ?'),
    archive: db.prepare(`UPDATE agents SET archivedAt=?, status='stopped', activity='removed' WHERE id=?`),
    insertAgent: db.prepare(`INSERT INTO agents (id, name, kind, role, avatarId, cwd, status, activity, nativeSessionId, createdAt, worktree, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateAgent: db.prepare(`UPDATE agents SET name=?, kind=?, role=?, avatarId=?, cwd=?, status=?, activity=?, nativeSessionId=?, worktree=?, model=? WHERE id=?`),
    setStatus: db.prepare('UPDATE agents SET status=?, activity=? WHERE id=?'),
    setSession: db.prepare('UPDATE agents SET nativeSessionId=? WHERE id=?'),
    deleteAgent: db.prepare('DELETE FROM agents WHERE id = ?'),
    deleteEvents: db.prepare('DELETE FROM events WHERE agentId = ?'),
    events: db.prepare('SELECT * FROM (SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
    agentEvents: db.prepare('SELECT * FROM (SELECT * FROM events WHERE agentId = ? AND id > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC'),
    insertEvent: db.prepare('INSERT INTO events (agentId, type, ts, sender, text, data) VALUES (?, ?, ?, ?, ?, ?)'),
    insertEventWithId: db.prepare('INSERT INTO events (id, agentId, type, ts, sender, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    resetBusy: db.prepare(`UPDATE agents SET status='idle', activity='idle (server restarted)' WHERE archivedAt IS NULL AND status IN (${BUSY.map(() => '?').join(',')})`),
    countAgents: db.prepare('SELECT COUNT(*) AS n FROM agents'),
    stats: db.prepare('SELECT agentId, COUNT(*) AS n, MAX(ts) AS lastTs FROM events GROUP BY agentId'),
    usage: db.prepare(`SELECT agentId, COUNT(*) AS turns,
      SUM(json_extract(data, '$.input')) AS input, SUM(json_extract(data, '$.output')) AS output,
      SUM(json_extract(data, '$.cacheRead')) AS cacheRead, SUM(json_extract(data, '$.cacheWrite')) AS cacheWrite,
      SUM(json_extract(data, '$.cost')) AS cost
      FROM events WHERE type = 'usage' AND ts >= ? GROUP BY agentId`),
  };

  const s: IStore = {
    getStoreType: () => 'sqlite',
    getAgents: () => q.agents.all().map(toAgent),
    getAllAgents: () => q.allAgents.all().map(toAgent),
    getAgent: (id, includeArchived) => {
      const r = q.agent.get(id);
      return r && (includeArchived || r.archivedAt == null) ? toAgent(r) : undefined;
    },
    createAgent: a => {
      q.insertAgent.run(a.id, a.name, a.kind, a.role, a.avatarId, a.cwd, a.status, a.activity, a.nativeSessionId ?? null, a.createdAt,
        a.worktree ? JSON.stringify(a.worktree) : null, a.model ?? null);
    },
    updateAgent: a => {
      q.updateAgent.run(a.name, a.kind, a.role, a.avatarId, a.cwd, a.status, a.activity, a.nativeSessionId ?? null,
        a.worktree ? JSON.stringify(a.worktree) : null, a.model ?? null, a.id);
    },
    setStatus: (id, status, activity) => { q.setStatus.run(status, activity, id); },
    setNativeSessionId: (id, sid) => { q.setSession.run(sid, id); },
    archiveAgent: id => { q.archive.run(Date.now(), id); },
    removeAgent: id => { q.deleteAgent.run(id); q.deleteEvents.run(id); },
    reset: () => { db.exec('DELETE FROM events; DELETE FROM agents;'); },
    getEvents: (after = 0, limit = -1) => q.events.all(after, limit).map(toEvent),
    getAgentEvents: (agentId, after = 0, limit = -1) => q.agentEvents.all(agentId, after, limit).map(toEvent),
    appendEvent: (e, agentId) => {
      const ts = Date.now();
      const r = q.insertEvent.run(agentId, e.type, ts, e.from ?? null, e.text ?? null, e.data !== undefined ? JSON.stringify(e.data) : null);
      return { ...e, id: Number(r.lastInsertRowid), ts, agentId };
    },
    resetBusyAgents: () => Number(q.resetBusy.run(...BUSY).changes),
    searchEvents: f => {
      const where: string[] = [];
      const args: any[] = [];
      if (f.q) {
        if (fts && f.q.length >= 3) {
          // A quoted phrase: the whole query as one string of trigrams.
          where.push('e.id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)');
          args.push(`"${f.q.replace(/"/g, '""')}"`);
        } else {
          where.push("e.text LIKE ? ESCAPE '\\'");
          args.push(`%${f.q.replace(/[\\%_]/g, m => '\\' + m)}%`);
        }
      }
      if (f.agentId) { where.push('e.agentId = ?'); args.push(f.agentId); }
      if (f.types?.length) { where.push(`e.type IN (${f.types.map(() => '?').join(',')})`); args.push(...f.types); }
      if (f.before) { where.push('e.id < ?'); args.push(f.before); }
      const sql = `SELECT e.* FROM events e ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, f.limit ?? 200).map(toEvent);
    },
    eventStats: () => q.stats.all().map((r: any) => ({ agentId: r.agentId, count: Number(r.n), lastTs: Number(r.lastTs) })),
    usageTotals: (since = 0) => q.usage.all(since).map((r: any) => ({
      agentId: r.agentId, turns: Number(r.turns), input: Number(r.input ?? 0), output: Number(r.output ?? 0),
      cacheRead: Number(r.cacheRead ?? 0), cacheWrite: Number(r.cacheWrite ?? 0), cost: Number(r.cost ?? 0),
    })),
    pruneEvents: (before, keep) => Number(db.prepare(
      `DELETE FROM events WHERE ts < ? ${keep.length ? `AND type NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
    ).run(before, ...keep).changes),
  };

  // One-time import of the JSON store written by earlier versions.
  const legacyPath = jsonPath(home);
  const legacyEventsPath = jsonEventsPath(home);
  if (existsSync(legacyPath) && (q.countAgents.get() as any).n === 0) {
    try {
      const data = JSON.parse(readFileSync(legacyPath, 'utf-8'));
      const imported = [...(Array.isArray(data.events) ? data.events : []), ...readEventLines(legacyEventsPath)]
        .sort((a: any, b: any) => a.id - b.id);
      const seen = new Set<number>();
      db.exec('BEGIN');
      for (const a of data.agents ?? []) s.createAgent(a);
      for (const e of imported) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        q.insertEventWithId.run(e.id, e.agentId, e.type, e.ts, e.from ?? null, e.text ?? null, e.data !== undefined ? JSON.stringify(e.data) : null);
      }
      db.exec('COMMIT');
      renameSync(legacyPath, legacyPath + '.imported');
      if (existsSync(legacyEventsPath)) renameSync(legacyEventsPath, legacyEventsPath + '.imported');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    }
  }

  return s;
}

// ---------- JSON fallback ----------

/**
 * The fallback for Node versions without node:sqlite. The agents live in one small file, the
 * events in an append-only file next to it: appending an event stays O(1), where rewriting
 * every event on every change grew quadratically with the number of events.
 */
function openJson(home: string): IStore {
  const path = jsonPath(home);
  const eventsPath = jsonEventsPath(home);
  let agents: Agent[] = [];
  let events: AgentEvent[] = [];
  let nextEventId = 1;
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      agents = data.agents || [];
      nextEventId = data.nextEventId || 1;
      if (Array.isArray(data.events)) {
        // The old format kept the events in the same file: move them to the append-only one.
        events = data.events;
        nextEventId = Math.max(nextEventId, events.reduce((m, e) => Math.max(m, e.id), 0) + 1);
        writeEventLines(eventsPath, events);
      }
    }
  } catch { /* fresh start */ }
  if (!events.length) {
    events = readEventLines(eventsPath);
    nextEventId = Math.max(nextEventId, events.reduce((m, e) => Math.max(m, e.id), 0) + 1);
  }

  // Coalesce writes: an agent can emit dozens of events per second.
  let saveTimer: NodeJS.Timeout | undefined;
  const flush = () => {
    saveTimer = undefined;
    try { writeFileSync(path, JSON.stringify({ agents, nextEventId })); } catch { /* ignore */ }
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
    getAgents: () => agents.filter(a => !a.archivedAt).map(a => ({ ...a })),
    getAllAgents: () => agents.map(a => ({ ...a })),
    getAgent: (id, includeArchived) => {
      const a = agents.find(x => x.id === id);
      return a && (includeArchived || !a.archivedAt) ? { ...a } : undefined;
    },
    createAgent: a => { agents.push({ ...a }); save(); },
    updateAgent: a => patch(a.id, { ...a }),
    setStatus: (id, status, activity) => patch(id, { status, activity }),
    setNativeSessionId: (id, nativeSessionId) => patch(id, { nativeSessionId }),
    archiveAgent: id => patch(id, { archivedAt: Date.now(), status: 'stopped', activity: 'removed' }),
    removeAgent: id => {
      agents = agents.filter(a => a.id !== id);
      events = events.filter(e => e.agentId !== id);
      writeEventLines(eventsPath, events);
      save();
    },
    reset: () => { agents = []; events = []; nextEventId = 1; writeEventLines(eventsPath, events); save(); },
    getEvents: (after = 0, limit = -1) => tail(events.filter(e => e.id > after), limit),
    getAgentEvents: (agentId, after = 0, limit = -1) => tail(events.filter(e => e.agentId === agentId && e.id > after), limit),
    searchEvents: f => {
      const q = f.q?.toLowerCase();
      const out: AgentEvent[] = [];
      for (let i = events.length - 1; i >= 0 && out.length < (f.limit ?? 200); i--) {
        const e = events[i];
        if (f.before && e.id >= f.before) continue;
        if (f.agentId && e.agentId !== f.agentId) continue;
        if (f.types?.length && !f.types.includes(e.type)) continue;
        if (q && !(e.text ?? '').toLowerCase().includes(q)) continue;
        out.push(e);
      }
      return out;
    },
    eventStats: () => {
      const m = new Map<string, { agentId: string; count: number; lastTs: number }>();
      for (const e of events) {
        const s = m.get(e.agentId) ?? { agentId: e.agentId, count: 0, lastTs: 0 };
        s.count++; s.lastTs = Math.max(s.lastTs, e.ts);
        m.set(e.agentId, s);
      }
      return [...m.values()];
    },
    usageTotals: (since = 0) => {
      const m = new Map<string, UsageTotal>();
      for (const e of events) {
        if (e.type !== 'usage' || e.ts < since) continue;
        const d = (e.data ?? {}) as Partial<Usage>;
        const t = m.get(e.agentId) ?? { agentId: e.agentId, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        t.turns++; t.input += d.input ?? 0; t.output += d.output ?? 0;
        t.cacheRead! += d.cacheRead ?? 0; t.cacheWrite! += d.cacheWrite ?? 0; t.cost! += d.cost ?? 0;
        m.set(e.agentId, t);
      }
      return [...m.values()];
    },
    pruneEvents: (before, keep) => {
      const n = events.length;
      events = events.filter(e => e.ts >= before || keep.includes(e.type));
      if (events.length !== n) { writeEventLines(eventsPath, events); save(); }
      return n - events.length;
    },
    appendEvent: (e, agentId) => {
      const full: AgentEvent = { ...e, id: nextEventId++, ts: Date.now(), agentId };
      events.push(full);
      // Append-only: one line, no rewrite of everything that came before.
      try { appendFileSync(eventsPath, JSON.stringify(full) + '\n'); } catch { /* reported on the next write */ }
      save();
      return full;
    },
    resetBusyAgents: () => {
      let n = 0;
      for (const a of agents) if (!a.archivedAt && BUSY.includes(a.status)) { a.status = 'idle'; a.activity = 'idle (server restarted)'; n++; }
      if (n) save();
      return n;
    },
  };
}

export type StoreKind = 'auto' | 'sqlite' | 'json';

/**
 * Open a store in `home`. 'auto' uses SQLite when Node has node:sqlite and the JSON files
 * otherwise. The factory exists so a test can open a second, independent store (the contract
 * test runs the same checks against both implementations).
 */
export function createStore(home: string, kind: StoreKind = 'auto', opts: { history?: boolean } = {}): IStore {
  mkdirSync(home, { recursive: true });
  const base = kind === 'json' ? openJson(home)
    : kind === 'sqlite' ? (openSqlite(home) ?? openJson(home))
      : (openSqlite(home) ?? openJson(home));
  return opts.history === false ? base : withHistory(base, home);
}

export const store: IStore = createStore(AGENTIX_HOME, process.env.AGENTIX_STORE === 'json' ? 'json' : 'auto');
