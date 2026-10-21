// Step 3: @@ commands from the coordinator and CEO, CEO digest, coordinator modes, settings.
import { TMP, waitFor, sleep } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { parseCommands, stripCommands } from '../src/commands.ts';
import { updateSettings, getSettings, cliPath } from '../src/settings.ts';

const sm = new SessionManager(new EventBus());
const idle = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)!.status === 'idle', 5000, `${id} idle`);
const evs = (id: string, type: string) => sm.getAgentEvents(id).filter(e => e.type === type);
const byName = (name: string) => sm.getAgents().find(a => a.name === name);

test('parseCommands: spawn/steer/stop/tell, bullets and errors', () => {
  const { commands, errors } = parseCommands([
    'Sure, on it.',
    '@@spawn kind=codex name=Rook avatar=3 cwd="/tmp/my dir" :: write the tests',
    '- @@steer Rook :: use pnpm',
    '`@@stop a_123`',
    '@@tell ceo :: all green',
    '@@steer Rook',
    '@@spawn name=x :: y',
    'not @@steer x :: y (mid-line)',
  ].join('\n'));
  assert.deepEqual(commands.map(c => c.op), ['spawn', 'steer', 'stop', 'tell']);
  assert.deepEqual((commands[0] as any).opts, { kind: 'codex', name: 'Rook', avatar: '3', cwd: '/tmp/my dir' });
  assert.equal((commands[0] as any).text, 'write the tests');
  assert.equal((commands[1] as any).target, 'Rook');
  assert.equal(errors.length, 2);
  assert.equal(stripCommands('hi\n@@tell coordinator :: x\nbye'), 'hi\nbye');
});

test('coordinator @@spawn creates a worker at work, @@steer and @@stop reach it', async () => {
  const coord = await sm.createAgent('mock', { role: 'coordinator', name: 'Boss' });
  await sm.steerAgent(coord.id, 'say: @@spawn kind=mock name=Rook avatar=4 :: build the thing');
  await waitFor(() => byName('Rook'), 3000, 'Rook spawned');
  const rook = byName('Rook')!;
  assert.equal(rook.role, 'worker');
  assert.equal(rook.avatarId, 4);
  assert.equal(evs(rook.id, 'agent.created')[0].from, coord.id);
  const msg = evs(rook.id, 'message')[0];
  assert.equal(msg.from, coord.id, 'message from the coordinator (paper plane)');
  await waitFor(() => evs(rook.id, 'output').some(e => e.text!.includes('build the thing')), 5000, 'Rook ran the task');

  await idle(coord.id);
  await sm.steerAgent(coord.id, 'say: @@steer rook :: switch to plan B');
  await waitFor(() => evs(rook.id, 'steer').some(e => e.text === 'switch to plan B' && e.from === coord.id), 3000, 'steer');
  await waitFor(() => sm.getAgent(rook.id)!.status === 'working', 3000, 'rook working');

  await idle(coord.id);
  await sm.steerAgent(coord.id, `say: @@stop ${rook.id}`);
  await waitFor(() => evs(rook.id, 'message').some(e => e.from === coord.id && e.text === 'stop'), 3000, 'stop sent');
  await waitFor(() => !sm.isRunning(rook.id) && ['idle', 'stopped'].includes(sm.getAgent(rook.id)!.status), 3000, 'rook not running');

  // bad commands become errors on the coordinator, not crashes
  await idle(coord.id);
  await sm.steerAgent(coord.id, 'say: @@steer Nobody :: hi');
  await waitFor(() => evs(coord.id, 'error').some(e => /no agent called "Nobody"/.test(e.text!)), 3000, 'error');
});

test('coordinator task assignment starts an existing idle worker', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
  const worker = await sm.createAgent('mock', { name: 'AssignedWorker' });
  const title = 'work an already-created assignment';
  await idle(coord.id).catch(() => {});
  await sm.steerAgent(coord.id, `say: @@task owner=${worker.name} :: ${title}`);
  await waitFor(() => evs(worker.id, 'output').some(e => e.text?.includes(title)), 8000, 'worker task turn');
  assert.equal(sm.getAgent(worker.id)!.status, 'idle');
});

test('a task kenz assigns on the board starts the idle worker, or queues behind its turn', async () => {
  const worker = await sm.createAgent('mock', { name: 'BoardWorker' });
  const first = sm.addTask({ title: 'board task one', owner: worker.name });
  await waitFor(() => sm.isRunning(worker.id), 2000, 'worker started');
  const second = sm.addTask({ title: 'board task two', owner: worker.id });
  await waitFor(() => evs(worker.id, 'output').some(e => e.text?.includes('board task two')), 8000, 'queued task ran next');
  assert.ok(evs(worker.id, 'output').some(e => e.text?.includes(`[TASK ${first.id}] board task one`)));
  assert.equal(evs(worker.id, 'steer').length, 0, 'the second task did not interrupt the first');

  // handing an existing to-do task to an idle worker starts it too
  await idle(worker.id);
  const loose = sm.addTask({ title: 'board task three' });
  sm.editTask(loose.id, { owner: worker.name });
  await waitFor(() => evs(worker.id, 'output').some(e => e.text?.includes('board task three')), 8000, 'reassigned task ran');
  await idle(worker.id);
  assert.equal(second.owner, worker.id);
});

test('CEO: sees the team digest, can only @@tell the coordinator', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
  await idle(coord.id).catch(() => {});
  const ceo = await sm.createAgent('mock', { role: 'ceo', name: 'Chief' });
  await sm.steerAgent(ceo.id, 'say: @@tell coordinator :: start the tests');
  await waitFor(() => evs(coord.id, 'message').some(e => e.from === ceo.id && e.text === 'start the tests'), 3000, 'CEO -> coordinator');
  const out = evs(ceo.id, 'output')[0].text!;
  assert.match(out, /^Done: \[TEAM STATUS\] - Boss \(/, 'digest comes first');
  assert.match(out, /\[FROM KENZ\]/);
  // ...and the coordinator gets it as an update turn
  await waitFor(() => evs(coord.id, 'message').some(e => e.from === 'system' && /CEO Chief says: "start the tests"/.test(e.text!)), 8000, 'update');

  const rook = byName('Rook')!;
  const before = evs(rook.id, 'steer').length;
  await idle(ceo.id);
  await sm.steerAgent(ceo.id, 'say: @@steer Rook :: do it now');
  await waitFor(() => evs(ceo.id, 'error').some(e => /CEO can only/.test(e.text!)), 3000, 'rejected');
  await sleep(200);
  assert.equal(evs(rook.id, 'steer').length, before, 'nothing from CEO to a worker');
});

test('coordinator @@tell ceo starts a CEO turn (queued while the CEO is busy)', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
  const ceo = sm.getAgents().find(a => a.role === 'ceo')!;
  await idle(ceo.id);
  await sm.steerAgent(ceo.id, 'think about lunch'); // keep the CEO busy
  await idle(coord.id).catch(() => {});
  await sm.steerAgent(coord.id, 'say: @@tell ceo :: tests are green');
  await waitFor(() => evs(ceo.id, 'message').some(e => e.from === coord.id && e.text === 'tests are green'), 3000, 'message');
  await waitFor(() => evs(ceo.id, 'output').some(e => /\[FROM COORDINATOR Boss\] tests are green/.test(e.text!)), 10000, 'CEO turn');
  // the lunch turn finished first (it wasn't interrupted)
  assert.ok(evs(ceo.id, 'output').some(e => e.text!.includes('think about lunch')));

  // A coordinator may have an older turn that says @@steer for a CEO report. Treat it
  // as @@tell so the report is delivered and the CEO's active turn is not interrupted.
  await idle(coord.id).catch(() => {});
  await sm.steerAgent(coord.id, 'say: @@steer Chief :: the delegation update is complete');
  await waitFor(() => evs(ceo.id, 'message').some(e => e.from === coord.id && e.text === 'the delegation update is complete'), 3000, 'legacy CEO report');
  await waitFor(() => evs(ceo.id, 'output').some(e => /delegation update is complete/.test(e.text!)), 10000, 'legacy CEO report turn');
  assert.equal(evs(coord.id, 'error').some(e => /use "@@tell ceo/.test(e.text!)), false, 'legacy report is not rejected');
});

test('an unanswered CEO request is retried three times and reported without interruption', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
  const ceo = sm.getAgents().find(a => a.role === 'ceo')!;
  const request = 'please acknowledge this request without using a CEO reply command';
  await idle(ceo.id).catch(() => {});
  await sm.steerAgent(ceo.id, `say: @@tell coordinator :: ${request}`);

  await waitFor(() => evs(coord.id, 'message').filter(e => e.from === ceo.id && e.text?.includes(request)).length >= 3, 6000, 'three CEO requests');
  await waitFor(() => evs(ceo.id, 'error').some(e => /after 3 requests/.test(e.text!)), 6000, 'CEO issue report');
  assert.equal(evs(coord.id, 'steer').some(e => e.from === ceo.id && e.text?.includes(request)), false, 'follow-ups do not interrupt the coordinator');
});

test('human coordinator mode: no updates, coordinator commands not run', async () => {
  updateSettings({ coordinatorMode: 'human' });
  try {
    const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
    await idle(coord.id).catch(() => {});
    const n = evs(coord.id, 'message').length;
    const w = await sm.createAgent('mock', { name: 'Solo', prompt: 'p' });
    await idle(w.id);
    await sm.steerAgent(coord.id, 'say: @@spawn kind=mock name=Ghost :: boo');
    await waitFor(() => evs(coord.id, 'error').some(e => /mode is "human"/.test(e.text!)), 3000, 'ignored');
    await sleep(300);
    assert.equal(byName('Ghost'), undefined);
    assert.equal(evs(coord.id, 'message').filter(e => e.from === 'system').length, evs(coord.id, 'message').slice(0, n).filter(e => e.from === 'system').length);
  } finally {
    updateSettings({ coordinatorMode: 'both' });
  }
});

test('askCoordinator queues kenz\'s note as an update', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
  const rook = byName('Rook')!;
  sm.askCoordinator('make Rook write docs', rook.id);
  assert.ok(evs(coord.id, 'message').some(e => e.from === 'user' && e.text === 'About Rook: make Rook write docs'));
  await waitFor(() => evs(coord.id, 'message').some(e => e.from === 'system' && e.text!.includes(`kenz about Rook (${rook.id}): "make Rook write docs"`)), 8000, 'update');
});

test('role instructions go to a CLI coordinator once per session', async () => {
  const c = await sm.createAgent('codex', { role: 'coordinator', name: 'CodexBoss', replace: true, prompt: 'hello team' });
  await idle(c.id);
  await sm.steerAgent(c.id, 'second turn');
  await idle(c.id);
  const raw = readFileSync(join(TMP, 'codex.args'), 'utf8');
  assert.equal(raw.split('You are the COORDINATOR').length - 1, 1, 'instructions sent once');
  assert.match(raw, /You are the COORDINATOR[\s\S]*hello team/);
  assert.match(raw, /second turn/);
});

test('settings persist and validate; cli path overrides', () => {
  assert.equal(getSettings().coordinatorMode, 'both');
  assert.throws(() => updateSettings({ coordinatorMode: 'boss' as any }));
  updateSettings({ cliPaths: { codex: ' /opt/codex ', opencode: '' } });
  assert.equal(cliPath('codex'), '/opt/codex');
  assert.equal(cliPath('opencode'), 'opencode');
  assert.match(readFileSync(join(process.env.AGENTIX_HOME!, 'settings.json'), 'utf8'), /\/opt\/codex/);
  updateSettings({ cliPaths: {} });
});

test('the CEO watchdog waits while the coordinator is working, and only counts idle time', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!; // CodexBoss, a CLI coordinator
  const ceo = sm.getAgents().find(a => a.role === 'ceo')!;
  await idle(coord.id).catch(() => {});
  await idle(ceo.id).catch(() => {});
  process.env.FAKE_HANG = '1'; // the fake codex hangs after its first line: a long coordinator turn
  try {
    await sm.steerAgent(coord.id, 'a long job');
    await waitFor(() => sm.isRunning(coord.id), 2000, 'coordinator busy');
  } finally { delete process.env.FAKE_HANG; }
  const request = 'status of the long job please';
  await sm.steerAgent(ceo.id, `say: @@tell coordinator :: ${request}`);
  await waitFor(() => evs(coord.id, 'message').some(e => e.from === ceo.id && e.text === request), 3000, 'request delivered');
  await sleep(2600); // well past two 1 s timeouts
  assert.equal(evs(coord.id, 'message').filter(e => e.from === ceo.id && /follow-up/.test(e.text!)).length, 0, 'no follow-ups while busy');
  assert.equal(evs(ceo.id, 'error').filter(e => /status of the long job/.test(JSON.stringify(e)) || /could not get a response/.test(e.text!)).length,
    evs(ceo.id, 'error').filter(e => /could not get a response/.test(e.text!)).length);
  const reportsBefore = evs(ceo.id, 'error').filter(e => /could not get a response/.test(e.text!)).length;

  // once it is idle and still silent, the follow-ups and the report come
  await sm.interruptAgent(coord.id);
  await waitFor(() => evs(coord.id, 'message').some(e => e.from === ceo.id && /follow-up 2\/3/.test(e.text!)), 8000, 'follow-up after idle');
  await waitFor(() => evs(ceo.id, 'error').filter(e => /could not get a response/.test(e.text!)).length > reportsBefore, 10000, 'reported');
});
