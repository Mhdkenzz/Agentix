// Work in flight survives a restart: the turn an agent was running, the turns queued behind the office
// limit, and the messages waiting for a busy agent are on disk and offered again by the next server.
import { waitFor } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { readPendingWork, writePendingWork } from '../src/pending.ts';

const outputs = (sm: SessionManager, id: string) => sm.getAgentEvents(id).filter(e => e.type === 'output').map(e => e.text!);
const firstLine = (sm: SessionManager, id: string) => outputs(sm, id).map(t => t.split('\n')[0]);
const idle = (sm: SessionManager, id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)!.status === 'idle', 10000, `${id} idle`);
const messages = (sm: SessionManager, id: string) => sm.getAgentEvents(id).filter(e => e.type === 'message').map(e => e.text ?? '');

test('the turn an agent is running is on disk, and gone once it ends', async () => {
  const sm = new SessionManager(new EventBus());
  const a = await sm.createAgent('mock', { name: 'Disk', prompt: 'count the tests' });
  await waitFor(() => sm.isRunning(a.id), 3000, 'working');

  const work = readPendingWork();
  assert.ok(work, 'a running turn is saved');
  assert.deepEqual(work.interrupted.map(t => t.prompt), ['count the tests']);
  assert.equal(work.interrupted[0].agentId, a.id);
  assert.ok(work.interrupted[0].startedAt, 'with when it started');

  await idle(sm, a.id);
  assert.equal(readPendingWork(), undefined, 'nothing is left to resume when the turn ended');
});

test('a restart offers the interrupted turn and the queue again, in order', async () => {
  process.env.AGENTIX_MAX_CONCURRENT_TURNS = '1';
  const sm = new SessionManager(new EventBus());
  let crashedId = '';
  let waitingId = '';
  try {
    const crashed = await sm.createAgent('mock', { name: 'Crashed' });
    crashedId = crashed.id;
    await sm.steerAgent(crashed.id, 'finish the migration');
    await waitFor(() => sm.isRunning(crashed.id), 3000, 'the first turn runs');
    const waiting = await sm.createAgent('mock', { name: 'Waiting', prompt: 'write the docs' });
    waitingId = waiting.id;
    await waitFor(() => /^queued/.test(sm.getAgent(waiting.id)!.activity), 3000, 'the second waits for a slot');
  } finally {
    delete process.env.AGENTIX_MAX_CONCURRENT_TURNS; // the restored turns may run side by side
  }

  // The server stops with one turn running and one waiting.
  await sm.shutdown();
  const saved = readPendingWork();
  assert.ok(saved, 'the work is saved when the server stops');
  assert.deepEqual(saved.interrupted.map(t => t.prompt), ['finish the migration']);
  assert.deepEqual(saved.queued.map(t => t.prompt), ['write the docs']);

  const restarted = new SessionManager(new EventBus());
  assert.equal(restarted.resumePendingTurns(), 2, 'both turns are taken over');
  await waitFor(() => !restarted.isRunning(crashedId) && !restarted.isRunning(waitingId)
    && restarted.getAgent(crashedId)!.status === 'idle' && restarted.getAgent(waitingId)!.status === 'idle', 15000, 'both turns ran');

  // The interrupted turn is a resume, not a silent repeat: the agent is told to check its work first.
  assert.match(firstLine(restarted, crashedId)[0], /^Done: \[AGENTIX\] The server restarted/);
  assert.match(outputs(restarted, crashedId)[0], /finish the migration/);
  assert.ok(messages(restarted, crashedId).some(t => /offered again/.test(t)), 'the log says what happened');
  // The queued turn keeps its own prompt.
  assert.equal(firstLine(restarted, waitingId)[0], 'Done: write the docs');
  assert.equal(readPendingWork(), undefined, 'the journal is empty when everything has run');
});

test('a task waiting behind a busy agent is delivered after the restart', async () => {
  const sm = new SessionManager(new EventBus());
  const busy = await sm.createAgent('mock', { name: 'BusyNote', prompt: 'long task' });
  await waitFor(() => sm.isRunning(busy.id), 3000, 'working');
  const task = sm.addTask({ title: 'look at the diff', owner: busy.id });
  await sm.shutdown();

  const saved = readPendingWork();
  assert.ok(saved, 'the waiting message is saved');
  assert.ok(saved.queued.some(turn => turn.agentId === busy.id && turn.taskId === task.id));

  const restarted = new SessionManager(new EventBus());
  restarted.resumePendingTurns();
  await waitFor(() => restarted.getAgentEvents(busy.id).filter(e => e.type === 'output').length >= 2, 15000, 'both turns ran');
  assert.match(outputs(restarted, busy.id)[1], /look at the diff/, 'the waiting message is the next turn');
  assert.ok(messages(restarted, busy.id).some(t => /waiting turn|waiting/i.test(t)));
  assert.equal(readPendingWork(), undefined);
});

test('a turn left by a killed process is offered again', async () => {
  const sm = new SessionManager(new EventBus());
  const a = await sm.createAgent('mock', { name: 'KilledBySignal' });
  // What the file holds when the process died: no shutdown ran, so only the journal remains.
  writePendingWork({ interrupted: [{ agentId: a.id, prompt: 'run the e2e tests', from: 'user', startedAt: Date.now() }], queued: [], inbox: {}, commandResults: {} });

  assert.equal(sm.resumePendingTurns(), 1);
  await waitFor(() => sm.getAgentEvents(a.id).some(e => e.type === 'output'), 8000, 'the turn ran');
  await idle(sm, a.id);
  const text = outputs(sm, a.id)[0];
  assert.match(text, /^Done: \[AGENTIX\] The server restarted/);
  assert.match(text, /run the e2e tests/);
  assert.equal(readPendingWork(), undefined);
});

test('a second crash during the resume does not stack the restart note', async () => {
  const sm = new SessionManager(new EventBus());
  const a = await sm.createAgent('mock', { name: 'CrashedTwice' });
  const once = '[AGENTIX] The server restarted in the middle of your last turn. Check what you already did ' +
    '(the files, the tests, the task) before continuing, then finish it.\n\nkeep going';
  // What the journal holds after a crash during the resumed turn.
  writePendingWork({ interrupted: [{ agentId: a.id, prompt: once, from: 'user' }], queued: [], inbox: {}, commandResults: {} });

  sm.resumePendingTurns();
  await waitFor(() => sm.getAgentEvents(a.id).some(e => e.type === 'output'), 8000, 'the turn ran');
  await idle(sm, a.id);
  assert.equal((outputs(sm, a.id)[0].match(/\[AGENTIX\] The server restarted/g) ?? []).length, 1, 'the note appears once');
  assert.match(outputs(sm, a.id)[0], /keep going/);
  assert.ok(messages(sm, a.id).some(t => /offered again: keep going$/.test(t)), 'the log names the instruction');
});

test('what came of an agent\'s commands survives the restart too', async () => {
  const sm = new SessionManager(new EventBus());
  const a = await sm.createAgent('mock', { name: 'CommandResults' });
  writePendingWork({
    interrupted: [],
    queued: [{ agentId: a.id, prompt: 'carry on', from: 'system' }],
    inbox: {},
    commandResults: { [a.id]: ['@@spawn Mock :: build it: spawned Rook (a_1)'] },
  });

  assert.equal(sm.resumePendingTurns(), 1);
  await waitFor(() => sm.getAgentEvents(a.id).some(e => e.type === 'output'), 8000, 'the turn ran');
  await idle(sm, a.id);
  const text = outputs(sm, a.id)[0];
  assert.match(text, /\[COMMAND RESULTS\]/);
  assert.match(text, /spawned Rook/);
  assert.match(text, /carry on/);
  assert.equal(readPendingWork(), undefined, 'the results were delivered once');
});

test('saved work for an agent that was removed meanwhile is dropped, not re-run', async () => {
  writePendingWork({
    interrupted: [{ agentId: 'a_gone', prompt: 'nobody is here', from: 'user' }],
    queued: [{ agentId: 'a_gone', prompt: 'still nobody', from: 'user' }],
    inbox: { a_gone: ['hello?'] },
    commandResults: { a_gone: ['@@spawn Mock :: nobody'] },
  });
  const sm = new SessionManager(new EventBus());
  assert.equal(sm.resumePendingTurns(), 0);
  assert.equal(readPendingWork(), undefined, 'the stale journal does not come back');
});
