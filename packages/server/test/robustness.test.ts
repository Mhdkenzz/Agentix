// The office never loses work: a turn that has to wait is queued (not dropped), a timeout says which
// instructions will not run, a shutdown starts nothing new, and a CLI that ignores signals is killed.
import { waitFor, sleep, TMP, WORK } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { createTask, getTask } from '../src/tasks.ts';
import { updateSettings } from '../src/settings.ts';

const sm = new SessionManager(new EventBus());
const evs = (id: string, type: string) => sm.getAgentEvents(id).filter(e => e.type === type);
const outputs = (id: string) => evs(id, 'output').map(e => e.text!.split('\n')[0]);
const idle = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)!.status === 'idle', 10000, `${id} idle`);

test('a turn that hits the office limit waits for a free slot instead of being dropped', async () => {
  process.env.AGENTIX_MAX_CONCURRENT_TURNS = '1';
  try {
    const first = await sm.createAgent('mock', { name: 'First', prompt: 'first job' });
    await waitFor(() => sm.isRunning(first.id), 3000, 'the first turn runs');
    const second = await sm.createAgent('mock', { name: 'Second', prompt: 'second job' });

    await waitFor(() => /^queued/.test(sm.getAgent(second.id)!.activity), 3000, 'the second is queued');
    assert.equal(sm.isRunning(second.id), false, 'it does not run beside the first');
    assert.equal(evs(second.id, 'error').length, 0, 'and it is not refused with an error');

    // Nobody has to remember to send it again: the turn starts on its own when the slot frees.
    await waitFor(() => outputs(second.id).includes('Done: second job'), 15000, 'the queued turn ran');
    await idle(first.id);
  } finally {
    delete process.env.AGENTIX_MAX_CONCURRENT_TURNS;
  }
});

test('a turn that times out names the instructions that were queued behind it', async () => {
  process.env.AGENTIX_TURN_TIMEOUT_MS = '100';
  try {
    const worker = await sm.createAgent('mock', { name: 'Slow' });
    await sm.steerAgent(worker.id, 'a long job');
    await waitFor(() => sm.isRunning(worker.id), 3000, 'it is working');
    const task = sm.addTask({ title: 'queued behind the slow turn', owner: worker.name });

    const drop = await waitFor(
      () => evs(worker.id, 'error').find(e => /were not run/.test(e.text!)),
      8000, 'the queued instruction is reported',
    );
    assert.match(drop.text!, /the turn timed out/, 'it says why');
    assert.match(drop.text!, /queued behind the slow turn/, 'and which instruction it was');
    assert.equal(sm.getAgent(worker.id)!.status, 'error');
    assert.equal(getTask(task.id)?.status, 'blocked', 'a dropped queued task is not left looking runnable');
    assert.match(getTask(task.id)?.note ?? '', /reopen to retry/);
  } finally {
    delete process.env.AGENTIX_TURN_TIMEOUT_MS;
  }
});

test('tasks left in "doing" by a stopped server go back on the board', async () => {
  const worker = await sm.createAgent('mock', { name: 'Reload' });
  const doing = createTask({ title: 'half done', owner: worker.id, status: 'doing', by: 'user' });
  const todo = createTask({ title: 'untouched', owner: worker.id, status: 'todo', by: 'user' });

  assert.equal(sm.resumeInterruptedTasks(), 1, 'only the task that was being worked on changes');
  assert.equal(getTask(doing.id)!.status, 'todo');
  assert.equal(getTask(todo.id)!.status, 'todo');
  assert.ok(evs(worker.id, 'task').some(e => e.text!.includes(doing.id) && /server restarted/.test(e.text!)),
    'the change is in the history');
  await sm.removeAgent(worker.id);
});

test('manual interrupt and new session leave active tasks retryable', async () => {
  const interruptedWorker = await sm.createAgent('mock', { name: 'Interrupted task' });
  const interruptedTask = sm.addTask({ title: 'finish after the interruption', owner: interruptedWorker.id });
  await waitFor(() => getTask(interruptedTask.id)?.status === 'doing', 3000, 'task started');
  await sm.interruptAgent(interruptedWorker.id);
  assert.equal(getTask(interruptedTask.id)?.status, 'todo');
  assert.match(getTask(interruptedTask.id)?.note ?? '', /Interrupted before completion/);

  const freshWorker = await sm.createAgent('mock', { name: 'Fresh session task' });
  const freshTask = sm.addTask({ title: 'continue in a fresh session', owner: freshWorker.id });
  await waitFor(() => getTask(freshTask.id)?.status === 'doing', 3000, 'fresh-session task started');
  await sm.newSession(freshWorker.id);
  assert.equal(getTask(freshTask.id)?.status, 'todo');
  assert.match(getTask(freshTask.id)?.note ?? '', /Interrupted before completion/);
  await sm.removeAgent(interruptedWorker.id);
  await sm.removeAgent(freshWorker.id);
});

test('reopening a blocked assigned task automatically retries it', async () => {
  const worker = await sm.createAgent('mock', { name: 'Task retry' });
  const task = sm.addTask({ title: 'retry after a failure', owner: worker.id });
  await waitFor(() => getTask(task.id)?.status === 'doing', 3000, 'task started');
  await sm.interruptAgent(worker.id);
  sm.editTask(task.id, { status: 'blocked', note: 'previous attempt failed' });
  sm.editTask(task.id, { status: 'todo' });
  await waitFor(() => getTask(task.id)?.status === 'review', 5000, 'the reopened task completes a fresh turn');
  assert.ok(outputs(worker.id).length > 0, 'the worker received the retry');
  await sm.removeAgent(worker.id);
});

test('steering a worker takes priority over a queued task without stranding it in doing', async () => {
  const worker = await sm.createAgent('mock', { name: 'Steer priority', prompt: 'long first turn' });
  await waitFor(() => sm.isRunning(worker.id), 2000, 'first turn starts');
  const task = sm.addTask({ title: 'queued behind the first turn', owner: worker.id });
  await sm.steerAgent(worker.id, 'handle this instruction first');
  assert.equal(getTask(task.id)?.status, 'todo', 'the queued task waits behind the steering turn');
  await waitFor(() => getTask(task.id)?.status === 'review', 5000, 'the queued task runs after the steering turn');
});

test('removing a worker cancels queued tasks before its current turn can finish', async () => {
  const worker = await sm.createAgent('mock', { name: 'Remove with queue', prompt: 'long first turn' });
  await waitFor(() => sm.isRunning(worker.id), 2000, 'first turn starts');
  const task = sm.addTask({ title: 'must not run after removal', owner: worker.id });
  await sm.removeAgent(worker.id);
  assert.equal(sm.isRunning(worker.id), false, 'removal waits for the active turn to stop');
  assert.equal(getTask(task.id)?.status, 'todo');
  assert.equal(getTask(task.id)?.owner, undefined, 'unfinished tasks return to the board');
  assert.equal(evs(worker.id, 'output').some(e => e.text?.includes(task.title)), false, 'queued work never starts on the removed worker');
});

test('a CLI that ignores SIGINT and SIGTERM is killed', async () => {
  const script = join(TMP, 'stubborn-codex');
  const pidFile = join(TMP, 'stubborn.pid');
  writeFileSync(script, `#!/bin/bash\ntrap '' INT TERM\nif [ "$1" = "--version" ]; then echo "stubborn 9.9.9"; exit 0; fi\necho $$ > "${pidFile}"\nsleep 30\n`);
  chmodSync(script, 0o755);
  updateSettings({ cliPaths: { codex: script } });
  try {
    const agent = await sm.createAgent('codex', { name: 'Stubborn', prompt: 'work' });
    const pid = await waitFor(
      () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined),
      5000, 'the CLI started',
    );
    assert.ok(pid > 0);

    await sm.interruptAgent(agent.id);
    assert.equal(sm.getAgent(agent.id)!.status, 'stopped');
    assert.equal(evs(agent.id, 'error').some(e => /did not stop/.test(e.text!)), false, 'it stopped properly');
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 5000, 'the CLI process is gone');
    await sm.removeAgent(agent.id);
  } finally {
    updateSettings({ cliPaths: {} });
  }
});

test('a timed-out CLI keeps its shared workspace reserved until its process group exits', async () => {
  process.env.AGENTIX_TURN_TIMEOUT_MS = '100';
  process.env.AGENTIX_KILL_GRACE_MS = '150';
  const script = join(TMP, 'workspace-stubborn-codex');
  const calls = join(TMP, 'workspace-stubborn.calls');
  const pidFile = join(TMP, 'workspace-stubborn.pid');
  writeFileSync(script, `#!/bin/bash
if [ "$1" = "--version" ]; then echo "stubborn 9.9.9"; exit 0; fi
if [ "$1" = "--help" ]; then echo "usage: codex exec --json"; exit 0; fi
echo "started $$" >> "${calls}"
echo $$ > "${pidFile}"
trap '' INT TERM
sleep 30
`);
  chmodSync(script, 0o755);
  updateSettings({ cliPaths: { codex: script } });
  try {
    const first = await sm.createAgent('codex', { name: 'Timed out', cwd: WORK, prompt: 'first' });
    const pid = await waitFor(() => existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined, 5000, 'the first CLI starts');
    const second = await sm.createAgent('codex', { name: 'Waiting for workspace', cwd: WORK, prompt: 'second' });
    await waitFor(() => evs(first.id, 'error').some(e => /was stopped/.test(e.text ?? '')), 5000, 'the first turn times out');
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'the second CLI cannot start while the first process group is alive');
    await waitFor(() => readFileSync(calls, 'utf8').trim().split('\n').length === 2, 5000, 'the queued CLI starts after cleanup');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000, 'the timed-out CLI exits before its replacement starts');
    await sm.interruptAgent(second.id);
  } finally {
    updateSettings({ cliPaths: {} });
    delete process.env.AGENTIX_TURN_TIMEOUT_MS;
    delete process.env.AGENTIX_KILL_GRACE_MS;
  }
});

test('one event cannot fill the database', () => {
  const long = 'x'.repeat(250_000);
  sm.emit('a_big', { type: 'output', text: long });
  const output = evs('a_big', 'output')[0];
  assert.ok(output.text!.length < long.length, 'the text is cut');
  assert.match(output.text!, /more characters were not stored/);

  sm.emit('a_big', { type: 'tool', text: 'big output', data: { output: 'y'.repeat(200_000) } });
  const tool = evs('a_big', 'tool')[0];
  assert.equal(tool.text, 'big output', 'the readable part stays');
  assert.deepEqual(Object.keys(tool.data as object).sort(), ['bytes', 'truncated']);
  assert.equal((tool.data as any).truncated, true);
});

// Last: after this the manager has been shut down.
test('shutdown does not start the turns that were waiting', async () => {
  process.env.AGENTIX_MAX_CONCURRENT_TURNS = '1';
  try {
    const running = await sm.createAgent('mock', { name: 'Running', prompt: 'keep going' });
    await waitFor(() => sm.isRunning(running.id), 3000, 'its turn is running');
    const later = await sm.createAgent('mock', { name: 'Later', prompt: 'never starts' });
    assert.match(sm.getAgent(later.id)!.activity, /^queued/);

    await sm.shutdown();
    await sleep(400);
    assert.equal(sm.isRunning(later.id), false, 'the queued turn never started');
    assert.deepEqual(outputs(later.id), [], 'and it produced nothing');
  } finally {
    delete process.env.AGENTIX_MAX_CONCURRENT_TURNS;
    await sm.resetWorkspace();
  }
});
