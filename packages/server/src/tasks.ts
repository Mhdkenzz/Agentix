// Agentix — the team's task board, kept in $AGENTIX_HOME/tasks.json.
//
// The coordinator plans with "@@task" lines, kenz edits the board in the dashboard, and the session manager
// moves a worker's tasks along on its own: doing while it works, review when its turn ends, blocked on failure.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, TaskStatus } from '../../shared/src/types.ts';
import { AGENTIX_HOME } from './store.ts';

export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'review', 'done', 'blocked'];
const MAX_TITLE = 300;

const file = () => join(AGENTIX_HOME, 'tasks.json');
let cache: Task[] | undefined;

export function listTasks(): Task[] {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(file(), 'utf8')).tasks ?? []; } catch { cache = []; }
  }
  return cache!.map(t => ({ ...t }));
}

function save(tasks: Task[]) {
  mkdirSync(AGENTIX_HOME, { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify({ tasks }, null, 2));
  renameSync(file() + '.tmp', file());
  cache = tasks;
}

export class TaskError extends Error {}

export function getTask(id: string): Task | undefined {
  return listTasks().find(t => t.id === id);
}

export function createTask(fields: { title: string; owner?: string; status?: TaskStatus; by: string; note?: string }): Task {
  const title = String(fields.title ?? '').trim().slice(0, MAX_TITLE);
  if (!title) throw new TaskError('a task needs a title');
  const status = fields.status ?? 'todo';
  if (!TASK_STATUSES.includes(status)) throw new TaskError(`status must be one of ${TASK_STATUSES.join(', ')}`);
  const now = Date.now();
  const tasks = listTasks();
  // short ids the coordinator can type: t1, t2, ...
  const n = tasks.reduce((m, t) => Math.max(m, Number(t.id.slice(1)) || 0), 0) + 1;
  const task: Task = {
    id: `t${n}`, title, status, by: fields.by, createdAt: now, updatedAt: now,
    ...(fields.owner ? { owner: fields.owner } : {}), ...(fields.note ? { note: fields.note } : {}),
  };
  save([...tasks, task]);
  return task;
}

export function updateTask(id: string, patch: { title?: string; status?: TaskStatus; owner?: string | null; note?: string }): Task {
  const tasks = listTasks();
  const t = tasks.find(x => x.id === id);
  if (!t) throw new TaskError(`no task ${id}`);
  if (patch.status !== undefined) {
    if (!TASK_STATUSES.includes(patch.status)) throw new TaskError(`status must be one of ${TASK_STATUSES.join(', ')}`);
    t.status = patch.status;
  }
  if (patch.title !== undefined) {
    const title = String(patch.title).trim().slice(0, MAX_TITLE);
    if (!title) throw new TaskError('a task needs a title');
    t.title = title;
  }
  if (patch.owner === null || patch.owner === '') delete t.owner;
  else if (patch.owner !== undefined) t.owner = patch.owner;
  if (patch.note !== undefined) t.note = String(patch.note).slice(0, 1000);
  t.updatedAt = Date.now();
  save(tasks);
  return { ...t };
}

export function deleteTask(id: string): boolean {
  const tasks = listTasks();
  const rest = tasks.filter(t => t.id !== id);
  if (rest.length === tasks.length) return false;
  save(rest);
  return true;
}

/** Remove every task from the board for a fresh workspace. */
export function clearTasks(): void {
  cache = [];
  try { rmSync(file(), { force: true }); } catch { /* best effort */ }
}
