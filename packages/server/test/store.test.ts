import { TMP } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { store, AGENTIX_HOME } from '../src/store.ts';
import type { Agent } from '../../shared/src/types.ts';

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: 'T', kind: 'mock', role: 'worker', avatarId: 3, cwd: '/tmp',
  status: 'idle', activity: 'idle', createdAt: Date.now(), ...extra,
});

test('store uses sqlite in the temp AGENTIX_HOME, not ~/.agentix', () => {
  assert.equal(AGENTIX_HOME, join(TMP, 'home'));
  assert.equal(store.getStoreType(), 'sqlite');
  assert.ok(existsSync(join(AGENTIX_HOME, 'agentix.db')));
});

test('agents: create, get, update, setStatus, session id, remove', () => {
  store.createAgent(agent('s1'));
  assert.equal(store.getAgent('s1')?.avatarId, 3);
  store.updateAgent({ ...store.getAgent('s1')!, name: 'Renamed', role: 'coordinator' });
  store.setStatus('s1', 'working', 'editing x');
  store.setNativeSessionId('s1', 'native-1');
  const got = store.getAgent('s1')!;
  assert.equal(got.name, 'Renamed');
  assert.equal(got.role, 'coordinator');
  assert.equal(got.status, 'working');
  assert.equal(got.activity, 'editing x');
  assert.equal(got.nativeSessionId, 'native-1');
  store.removeAgent('s1');
  assert.equal(store.getAgent('s1'), undefined);
});

test('events: ids increase, `from` round-trips, after/limit filter', () => {
  store.createAgent(agent('s2'));
  const a = store.appendEvent({ type: 'steer', from: 'user', text: 'one' }, 's2');
  const b = store.appendEvent({ type: 'output', text: 'two', data: { x: 1 } }, 's2');
  const c = store.appendEvent({ type: 'output', text: 'three' }, 's2');
  assert.ok(b.id > a.id && c.id > b.id);

  const all = store.getAgentEvents('s2');
  assert.deepEqual(all.map(e => e.text), ['one', 'two', 'three']);
  assert.equal(all[0].from, 'user');
  assert.deepEqual(all[1].data, { x: 1 });
  assert.deepEqual(store.getAgentEvents('s2', a.id).map(e => e.text), ['two', 'three']);
  assert.deepEqual(store.getAgentEvents('s2', 0, 1).map(e => e.text), ['three']);
  assert.deepEqual(store.getEvents(b.id).map(e => e.text), ['three']);
  store.removeAgent('s2');
});

test('resetBusyAgents marks mid-turn agents idle and leaves the rest alone', () => {
  store.createAgent(agent('s3', { status: 'thinking', activity: 'thinking…' }));
  store.createAgent(agent('s4', { status: 'working', activity: 'x' }));
  store.createAgent(agent('s5', { status: 'error', activity: 'error: y' }));
  assert.equal(store.resetBusyAgents(), 2);
  assert.equal(store.getAgent('s3')?.status, 'idle');
  assert.equal(store.getAgent('s4')?.activity, 'idle (server restarted)');
  assert.equal(store.getAgent('s5')?.status, 'error');
  for (const id of ['s3', 's4', 's5']) store.removeAgent(id);
});
