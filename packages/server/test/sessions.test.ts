// Session manager with the mock adapter: steer, roles, coordinator updates.
import { waitFor, sleep } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus.ts';
import { SessionManager, HttpError } from '../src/sessions.ts';
import type { AgentEvent } from '../../shared/src/types.ts';

const bus = new EventBus();
const sm = new SessionManager(bus);
const idle = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)!.status === 'idle', 5000, `${id} idle`);
const outputs = (id: string) => sm.getAgentEvents(id).filter(e => e.type === 'output').map(e => e.text!.split('\n')[0]);

test('every stored event is also published on the bus', async () => {
  const seen: AgentEvent[] = [];
  const off = bus.subscribe(e => seen.push(e));
  const a = await sm.createAgent('mock', { prompt: 'hello' });
  await idle(a.id);
  off();
  assert.deepEqual(seen.filter(e => e.agentId === a.id).map(e => e.id), sm.getAgentEvents(a.id).map(e => e.id));
  assert.deepEqual(outputs(a.id), ['Done: hello']);
});

test('steer mid-turn replaces the turn: the old one never finishes', async () => {
  const a = await sm.createAgent('mock', { prompt: 'first' });
  await waitFor(() => sm.getAgent(a.id)!.status === 'working', 2000, 'working');
  await sm.steerAgent(a.id, 'second');
  await idle(a.id);
  await sleep(300); // give a leaked first turn time to show up
  assert.deepEqual(outputs(a.id), ['Done: second']);
});

test('two steers at once: only the last one runs to completion', async () => {
  const a = await sm.createAgent('mock', { prompt: 'first' });
  await waitFor(() => sm.getAgent(a.id)!.status === 'working', 2000, 'working');
  await Promise.all([sm.steerAgent(a.id, 'second'), sm.steerAgent(a.id, 'third')]);
  await idle(a.id);
  await sleep(300);
  assert.equal(outputs(a.id).length, 1);
});

test('three agents run at once without interfering', async () => {
  const as = await Promise.all(['x', 'y', 'z'].map(p => sm.createAgent('mock', { prompt: p })));
  await Promise.all(as.map(a => idle(a.id)));
  assert.deepEqual(as.map(a => outputs(a.id)), [['Done: x'], ['Done: y'], ['Done: z']]);
});

test('avatar: random by default, explicit 0-9 honoured, others rejected', async () => {
  assert.equal((await sm.createAgent('mock', { avatarId: 7 })).avatarId, 7);
  const ids = new Set<number>();
  for (let i = 0; i < 30; i++) ids.add((await sm.createAgent('mock', {})).avatarId);
  assert.ok(ids.size > 1, 'random avatars should vary');
  await assert.rejects(sm.createAgent('mock', { avatarId: 12 }), HttpError);
  await assert.rejects(sm.createAgent('nope', {}), /Unknown agent kind/);
});

test('only one coordinator: 409 unless replace, which demotes the old one', async () => {
  const c1 = await sm.createAgent('mock', { role: 'coordinator', name: 'Boss' });
  await assert.rejects(sm.createAgent('mock', { role: 'coordinator' }), (e: any) => e.status === 409);
  const c2 = await sm.createAgent('mock', { role: 'coordinator', replace: true });
  assert.equal(sm.getAgent(c1.id)!.role, 'worker');
  assert.equal(sm.getAgent(c2.id)!.role, 'coordinator');
  sm.updateAgent(c2.id, { role: 'worker' });
});

test('coordinator gets a batched [AGENTIX UPDATE] turn for steers and finished workers', async () => {
  const coord = await sm.createAgent('mock', { role: 'coordinator', name: 'Coord' });
  const w = await sm.createAgent('mock', { name: 'Worker1', prompt: 'build it' });
  await waitFor(() => sm.getAgent(w.id)!.status === 'working', 2000, 'worker working');
  await sm.steerAgent(w.id, 'use pnpm instead');
  await idle(w.id);

  const msgs = () => sm.getAgentEvents(coord.id).filter(e => e.type === 'message');
  await waitFor(() => msgs().some(m => m.text!.includes('finished its turn')), 3000, 'coordinator update');
  const all = msgs().map(m => m.text!).join('\n');
  assert.match(all, /^\[AGENTIX UPDATE\]/);
  assert.match(all, /kenz steered Worker1 \(a_\w+\): "use pnpm instead"/);
  assert.match(all, /Worker1 \(a_\w+\) finished its turn/);
  assert.match(all, /Team:\n- /);
  assert.equal(msgs()[0].from, 'system');

  // ...and the update is delivered as a coordinator turn
  await waitFor(() => outputs(coord.id).some(o => o.startsWith('Done: [AGENTIX UPDATE]')), 3000, 'coordinator turn');
  // the coordinator's own turns don't trigger updates to itself
  await sleep(300);
  const n = msgs().length;
  await sleep(300);
  assert.equal(msgs().length, n);
  sm.updateAgent(coord.id, { role: 'worker' });
});

test('stop on an idle agent is a no-op; remove takes the agent out but keeps its record and history', async () => {
  const a = await sm.createAgent('mock', { prompt: 'p' });
  await idle(a.id);
  await sm.interruptAgent(a.id);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  await sm.removeAgent(a.id);
  assert.equal(sm.getAgent(a.id), undefined);
  assert.ok(sm.getAgent(a.id, true)?.archivedAt);
  assert.ok(sm.getAgentEvents(a.id).some(e => e.type === 'output'));
  await assert.rejects(sm.steerAgent(a.id, 'x'), (e: any) => e.status === 404);
});
