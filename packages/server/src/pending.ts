// Agentix — the work that is in flight, kept in $AGENTIX_HOME/pending.json.
//
// A server can stop in the middle of a turn, or with turns queued behind the office limit, or with
// messages waiting for an agent to finish. Before this file they were only in memory, so a restart (or
// a crash) lost the instruction an agent was following while the task board still said "todo".
//
//   interrupted    turns that were running when the server stopped (offered again at the next start)
//   queued         turns that were waiting for a free slot, oldest first
//   inbox          messages waiting for an agent to finish its current turn
//   commandResults what came of the @@ commands an agent wrote, for its next turn's [COMMAND RESULTS]
//
// Every turn start/end and every queue or inbox change rewrites it, so a killed process is covered too.
// Small (a few prompts) and written atomically, like tasks.json.
import { writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTIX_HOME } from './store.ts';
import { isJsonRecord, readJsonFile, quarantineJsonFile } from './json-files.ts';

export interface PendingTurn {
  agentId: string;
  prompt: string;
  taskId?: string;
  /** who asked: 'user', 'system' or the id of the agent that did */
  from: string;
  /** when the turn started (interrupted turns only) */
  startedAt?: number;
}

export interface PendingWork {
  interrupted: PendingTurn[];
  queued: PendingTurn[];
  inbox: Record<string, string[]>;
  commandResults: Record<string, string[]>;
}

/** Same cap as one event: a prompt is a prompt, not a whole file. */
export const MAX_PENDING_PROMPT = 100_000;
export const MAX_INBOX_MESSAGES = 100;
export const MAX_INBOX_MESSAGE = 2_000;

const file = () => join(AGENTIX_HOME, 'pending.json');

function turn(value: any): PendingTurn | undefined {
  if (!value || typeof value.agentId !== 'string' || typeof value.prompt !== 'string' || !value.prompt.trim()) return undefined;
  return {
    agentId: value.agentId,
    prompt: value.prompt.slice(0, MAX_PENDING_PROMPT),
    ...(typeof value.taskId === 'string' && /^t\d+$/.test(value.taskId) ? { taskId: value.taskId } : {}),
    from: typeof value.from === 'string' ? value.from : 'system',
    ...(Number.isFinite(value.startedAt) ? { startedAt: Number(value.startedAt) } : {}),
  };
}

function turns(value: any): PendingTurn[] {
  return Array.isArray(value) ? value.map(turn).filter((t): t is PendingTurn => Boolean(t)) : [];
}

/** The saved work, or undefined when there is none (or the file is unreadable/torn). */
export function readPendingWork(): PendingWork | undefined {
  const data = readJsonFile(file(), 'pending work');
  if (data === undefined) return undefined;
  if (!isJsonRecord(data) || !Array.isArray(data.interrupted) || !Array.isArray(data.queued)
    || !isJsonRecord(data.inbox) || !isJsonRecord(data.commandResults)) {
    quarantineJsonFile(file(), 'pending work file has an invalid structure');
    return undefined;
  }
  try {
    const lines = (value: any): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      if (!value || typeof value !== 'object') return out;
      for (const [agentId, list] of Object.entries(value)) {
        if (!Array.isArray(list)) continue;
        const kept = list.filter(m => typeof m === 'string' && m.trim()).slice(-MAX_INBOX_MESSAGES).map(m => String(m).slice(0, MAX_INBOX_MESSAGE));
        if (kept.length) out[agentId] = kept;
      }
      return out;
    };
    return {
      interrupted: turns(data?.interrupted),
      queued: turns(data?.queued),
      inbox: lines(data?.inbox),
      commandResults: lines(data?.commandResults),
    };
  } catch { return undefined; }
}

/** Save the work in flight. Nothing left means no file: a stale journal must not outlive the work. */
export function writePendingWork(work: PendingWork): void {
  if (!work.interrupted.length && !work.queued.length
    && !Object.keys(work.inbox).length && !Object.keys(work.commandResults).length) {
    clearPendingWork();
    return;
  }
  mkdirSync(AGENTIX_HOME, { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify(work));
  renameSync(file() + '.tmp', file());
}

export function clearPendingWork(): void {
  try {
    rmSync(file(), { force: true });
  } catch {
    /* best effort */
  }
}
