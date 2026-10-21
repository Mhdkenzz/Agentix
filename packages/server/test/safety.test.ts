// Safety rails: a command that fails comes back to its author, a hung turn is stopped,
// an agent that leaves hands its tasks over, the office has limits, and a crashed server's CLIs are cleaned up.
import { waitFor, sleep } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { getTask } from '../src/tasks.ts';
import { registerRun, killOrphanRuns } from '../src/procs.ts';

const sm = new SessionManager(new EventBus());
const evs = (id: string, type: string) => sm.getAgentEvents(id).filter(e => e.type === type);
const idle = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)!.status === 'idle', 8000, `${id} idle`);

// The limits come first: they are about the office as a whole, and no coordinator exists yet.
test('the office has a limit on agents and on turns at the same time', async () => {
  process.env.AGENTIX_MAX_AGENTS = '2';
  try {
    await sm.createAgent('mock', { name: 'Cap1' });
    await sm.createAgent('mock', { name: 'Cap2' });
    await assert.rejects(() => sm.createAgent('mock', { name: 'Cap3' }), /office is full/);
  } finally {
    delete process.env.AGENTIX_MAX_AGENTS;
  }

  process.env.AGENTIX_MAX_CONCURRENT_TURNS = '1';
  try {
    const a = await sm.createAgent('mock', { name: 'Busy' });
    const b = await sm.createAgent('mock', { name: 'Waiting' });
    await sm.steerAgent(a.id, 'go');
    await waitFor(() => sm.isRunning(a.id), 2000, 'the first agent is working');
    await sm.steerAgent(b.id, 'go');
    await waitFor(() => evs(b.id, 'error').some(e => /Too many agents are working/.test(e.text!)), 3000, 'the second is refused');
    assert.equal(sm.isRunning(b.id), false, 'and it does not start');
    await idle(a.id);
  } finally {
    delete process.env.AGENTIX_MAX_CONCURRENT_TURNS;
  }
});

test('a turn that never ends is stopped and its task is blocked', async () => {
  process.env.AGENTIX_TURN_TIMEOUT_MS = '120';
  try {
    const worker = await sm.createAgent('mock', { name: 'Slowpoke' });
    const task = sm.addTask({ title: 'a long job', owner: worker.name });
    await waitFor(() => getTask(task.id)!.status === 'doing', 5000, 'the task is being worked on');
    await waitFor(() => evs(worker.id, 'error').some(e => /was stopped/.test(e.text!)), 5000, 'the timeout');
    assert.equal(sm.getAgent(worker.id)!.status, 'error');
    assert.equal(getTask(task.id)!.status, 'blocked', 'the task is not left hanging');
  } finally {
    delete process.env.AGENTIX_TURN_TIMEOUT_MS;
  }
});

test('an agent that leaves the office hands its open tasks back to the board', async () => {
  const worker = await sm.createAgent('mock', { name: 'Leaver' });
  const task = sm.addTask({ title: 'unfinished work', owner: worker.name });
  await waitFor(() => getTask(task.id)!.status === 'doing', 5000, 'the task is being worked on');
  await sm.removeAgent(worker.id);
  const left = getTask(task.id)!;
  assert.equal(left.status, 'todo', 'nobody is working on it any more');
  assert.equal(left.owner, undefined, 'and it has no owner');
  assert.ok(evs(worker.id, 'task').some(e => /left the office/.test(e.text!)), 'the change is in the history');
});

test('a command that fails comes back to the agent that wrote it', async () => {
  const coord = await sm.createAgent('mock', { role: 'coordinator', name: 'Boss' });
  await sm.steerAgent(coord.id, 'say: @@steer Nobody :: hi');
  await waitFor(() => evs(coord.id, 'error').some(e => /no agent called "Nobody"/.test(e.text!)), 8000, 'error');
  // ...and the agent hears about it in a turn of its own
  await waitFor(() => evs(coord.id, 'output').some(e => e.text!.includes('[COMMAND RESULTS]')), 10000, 'result turn');
  const out = evs(coord.id, 'output').find(e => e.text!.includes('[COMMAND RESULTS]'))!.text!;
  assert.match(out, /no agent called "Nobody"/, 'the failure is in the prompt of the next turn');
  assert.match(out, /@@steer Nobody :: hi/, 'the command that failed is named');
});

test('a misspelled command is not silently ignored', async () => {
  const ceo = await sm.createAgent('mock', { role: 'ceo', name: 'Typo' });
  await sm.steerAgent(ceo.id, 'say: @@steerr Rook :: hi');
  await waitFor(() => evs(ceo.id, 'error').some(e => /unknown command "@@steerr"/.test(e.text!)), 8000, 'error');
  assert.ok(evs(ceo.id, 'error').some(e => /did you mean "@@steer"/.test(e.text!)), 'the error names the right verb');
});

test('the CLIs a crashed server left behind are stopped', async () => {
  // a pid that is long gone: the record is dropped, nothing is killed
  registerRun(999_999, 'sleep', 'a_gone');
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  registerRun(pid, 'sleep', 'a_orphan');

  const stopped = await killOrphanRuns();
  assert.equal(stopped, 1, 'only the process that is really running is stopped');
  await exited;
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the orphan is gone');
  await sleep(50);
});
