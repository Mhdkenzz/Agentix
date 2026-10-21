// Agentix — the team's task board, kept in $AGENTIX_HOME/tasks.json.
//
// The coordinator plans with "@@task" lines, kenz edits the board in the dashboard, and the session manager
// moves a worker's tasks along on its own: doing while it works, review when its turn ends, blocked on failure.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskStatus } from '../../shared/src/types.ts';
import { AGENTIX_HOME } from './store.ts';

export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'review', 'done', 'blocked'];
const MAX_TITLE = 300;

const file = () => join(AGENTIX_HOME, 'tasks.json');
let cache: Task[] | undefined;
/** The next task number. It only ever goes up, so a deleted task never hands its id to a new one. */
let nextId = 1;

export function listTasks(): Task[] {
  if (!cache) {
    try {
      const data = JSON.parse(readFileSync(file(), 'utf8'));
      const tasks: Task[] = data.tasks ?? [];
      cache = tasks;
      nextId = Math.max(Number(data.nextId) || 1, ...tasks.map(t => (Number(t.id.slice(1)) || 0) + 1));
    } catch { cache = []; nextId = 1; }
  }
  return cache!.map(t => ({ ...t }));
}

function save(tasks: Task[]) {
  mkdirSync(AGENTIX_HOME, { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify({ tasks, nextId }, null, 2));
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
  // short ids the coordinator can type: t1, t2, ... They never repeat, not even after a delete.
  const n = nextId++;
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
  nextId = 1;
  try { rmSync(file(), { force: true }); } catch { /* best effort */ }
}
