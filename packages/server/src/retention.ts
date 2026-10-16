// Agentix — event retention: the database keeps the last `retentionDays` days of events, so the dashboard and
// History stay fast after months of use. Nothing is lost: $AGENTIX_HOME/history/*.jsonl keeps every event.
import { store } from './store.ts';
import { getSettings } from './settings.ts';

/** Kept whatever their age: what agents, usage totals and the task board are built from. */
export const KEEP_TYPES = ['agent.created', 'agent.updated', 'agent.removed', 'usage', 'task', 'session'];

export function pruneOldEvents(now = Date.now()): number {
  const days = getSettings().retentionDays;
  if (!days) return 0;
  const removed = store.pruneEvents(now - days * 86_400_000, KEEP_TYPES);
  if (removed) console.log(`agentix: removed ${removed} events older than ${days} days from the database (history files keep them)`);
  return removed;
}
