// Agentix — permanent history on disk, next to the database, as plain JSON Lines files:
//
//   $AGENTIX_HOME/history/agents.jsonl     one line each time an agent is created, changed or removed
//   $AGENTIX_HOME/history/<agentId>.jsonl  every event of that agent, in order
//
// The database is what the server reads; these files are an append-only copy that survives removing an
// agent, a broken database, or a reinstall, and can be read with any tool (jq, grep, an editor).
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../../shared/src/types.ts';
import type { IStore } from './store.ts';

export function historyDir(home: string): string {
  return join(home, 'history');
}

/** Wrap a store so every agent change and every event is also appended to the history files. */
export function withHistory(base: IStore, home: string): IStore {
  const dir = historyDir(home);
  try { mkdirSync(dir, { recursive: true }); } catch { /* reported on first write */ }
  let warned = false;
  const append = (file: string, record: unknown) => {
    try {
      appendFileSync(join(dir, file), JSON.stringify(record) + '\n');
    } catch (err: any) {
      if (!warned) { warned = true; console.error(`agentix: cannot write history in ${dir}: ${err?.message ?? err}`); }
    }
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
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort; the database is already reset */ }
      try { mkdirSync(dir, { recursive: true }); } catch { /* reported on the next history write */ }
    },
  };
}
