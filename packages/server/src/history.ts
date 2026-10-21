// Agentix — permanent history on disk, next to the database, as plain JSON Lines files:
//
//   $AGENTIX_HOME/history/agents.jsonl     one line each time an agent is created, changed or removed
//   $AGENTIX_HOME/history/<agentId>.jsonl  every event of that agent, in order
//
// The database is what the server reads; these files are an append-only copy that survives removing an
// agent, a broken database, or a reinstall, and can be read with any tool (jq, grep, an editor).
//
// The lines are buffered and written in one go every few hundred milliseconds: an agent can emit
// dozens of events per second, and one synchronous write per event would slow the whole server down.
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent } from '../../shared/src/types.ts';
import type { IStore } from './store.ts';

export function historyDir(home: string): string {
  return join(home, 'history');
}

/** Lines waiting to be written: full path -> the lines to append. */
const pending = new Map<string, string[]>();
let flushTimer: NodeJS.Timeout | undefined;
let exitHooked = false;

const FLUSH_MS = 200;

/** Write everything that is still waiting on disk. */
export async function flushHistory(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
  const writes = [...pending.entries()];
  pending.clear();
  for (const [path, lines] of writes) {
    if (!lines.length) continue;
    try {
      await appendFile(path, lines.join(''));
    } catch (err: any) {
      warnOnce(path, err);
    }
  }
}

const warned = new Set<string>();
function warnOnce(path: string, err: any): void {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (warned.has(dir)) return;
  warned.add(dir);
  console.error(`agentix: cannot write history in ${dir}: ${err?.message ?? err}`);
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = undefined; void flushHistory(); }, FLUSH_MS);
  flushTimer.unref();
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  // The server may die at any moment: what is still buffered goes to disk.
  process.on('exit', () => {
    for (const [path, lines] of pending) {
      if (!lines.length) continue;
      try { appendFileSync(path, lines.join('')); } catch { /* nothing to do at exit */ }
    }
    pending.clear();
  });
}

/** Wrap a store so every agent change and every event is also appended to the history files. */
export function withHistory(base: IStore, home: string): IStore {
  const dir = historyDir(home);
  try { mkdirSync(dir, { recursive: true }); } catch { /* reported on the first write */ }
  hookExit();
  const append = (file: string, record: unknown) => {
    const path = join(dir, file);
    const line = JSON.stringify(record) + '\n';
    const buffer = pending.get(path);
    if (buffer) buffer.push(line);
    else pending.set(path, [line]);
    scheduleFlush();
  };
  const agentLine = (op: string, agent: Agent | undefined) => { if (agent) append('agents.jsonl', { ts: Date.now(), op, agent }); };
  const safeId = (id: string) => id.replace(/[^\w.-]/g, '_');

  return {
    ...base,
    createAgent: a => { base.createAgent(a); agentLine('created', a); },
    updateAgent: a => { base.updateAgent(a); agentLine('updated', base.getAgent(a.id, true) ?? a); },
    setNativeSessionId: (id, sid) => { base.setNativeSessionId(id, sid); agentLine('session', base.getAgent(id, true)); },
    archiveAgent: id => { base.archiveAgent(id); agentLine('removed', base.getAgent(id, true)); },
    appendEvent: (e, agentId) => {
      const full = base.appendEvent(e, agentId);
      append(`${safeId(agentId)}.jsonl`, full);
      return full;
    },
    reset: () => {
      base.reset();
      for (const path of [...pending.keys()]) if (path.startsWith(dir)) pending.delete(path);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort; the database is already reset */ }
      try { mkdirSync(dir, { recursive: true }); } catch { /* reported on the next history write */ }
    },
  };
}
