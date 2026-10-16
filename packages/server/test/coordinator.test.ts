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
  const coord = sm.createAgent('mock', { role: 'coordinator', name: 'Boss' });
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

test('CEO: sees the team digest, can only @@tell the coordinator', async () => {
  const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
  await idle(coord.id).catch(() => {});
  const ceo = sm.createAgent('mock', { role: 'ceo', name: 'Chief' });
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
});

test('human coordinator mode: no updates, coordinator commands not run', async () => {
  updateSettings({ coordinatorMode: 'human' });
  try {
    const coord = sm.getAgents().find(a => a.role === 'coordinator')!;
    await idle(coord.id).catch(() => {});
    const n = evs(coord.id, 'message').length;
    const w = sm.createAgent('mock', { name: 'Solo', prompt: 'p' });
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
  const c = sm.createAgent('codex', { role: 'coordinator', name: 'CodexBoss', replace: true, prompt: 'hello team' });
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
