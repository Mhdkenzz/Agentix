// The SQLite store and the JSON fallback must behave the same. The same checks run against both,
// so a difference between them shows up here instead of in production on a Node without node:sqlite.
import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.ts';
import type { Agent } from '../../shared/src/types.ts';

const mkAgent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: 'mock', role: 'worker', avatarId: 0, cwd: '/tmp',
  status: 'idle', activity: 'idle', createdAt: 1, ...over,
});

function contract(kind: 'sqlite' | 'json') {
  const home = mkdtempSync(join(tmpdir(), `agentix-contract-${kind}-`));
  const store = createStore(home, kind, { history: false });

  test(`${kind}: agents are created, changed, archived and removed`, () => {
    assert.equal(store.getStoreType(), kind);
    store.createAgent(mkAgent('a1', { name: 'Rook' }));
    store.createAgent(mkAgent('a2', { name: 'Nova' }));
    assert.deepEqual(store.getAgents().map(a => a.id), ['a1', 'a2']);
    assert.equal(store.getAgent('a1')!.name, 'Rook');

    store.setStatus('a1', 'working', 'editing src/app.ts');
    assert.equal(store.getAgent('a1')!.status, 'working');
    assert.equal(store.getAgent('a1')!.activity, 'editing src/app.ts');
    store.setNativeSessionId('a1', 'sess-1');
    assert.equal(store.getAgent('a1')!.nativeSessionId, 'sess-1');

    const a1 = store.getAgent('a1')!;
    a1.name = 'Rook II';
    store.updateAgent(a1);
    assert.equal(store.getAgent('a1')!.name, 'Rook II');

    store.archiveAgent('a2');
    assert.deepEqual(store.getAgents().map(a => a.id), ['a1'], 'an archived agent leaves the office');
    assert.equal(store.getAgent('a2'), undefined);
    assert.equal(store.getAgent('a2', true)!.name, 'Nova', 'but its record is kept');
    assert.equal(store.getAllAgents().length, 2);

    store.removeAgent('a2');
    assert.equal(store.getAllAgents().length, 1);
    assert.equal(store.getAgent('a2', true), undefined);
  });

  test(`${kind}: events are appended and read back in order`, () => {
    store.createAgent(mkAgent('a3', { name: 'Kai' }));
    const e1 = store.appendEvent({ type: 'output', text: 'Hello' }, 'a1');
    const e2 = store.appendEvent({ type: 'error', text: 'boom' }, 'a1');
    const e3 = store.appendEvent({ type: 'output', text: 'from a3' }, 'a3');
    assert.ok(e1.id > 0 && e2.id > e1.id && e3.id > e2.id, 'event ids grow');
    assert.equal(e1.agentId, 'a1');
    assert.ok(e1.ts > 0);

    assert.deepEqual(store.getEvents().map(e => e.id), [e1.id, e2.id, e3.id], 'oldest first');
    assert.deepEqual(store.getEvents(e1.id).map(e => e.id), [e2.id, e3.id], 'after skips what came before');
    assert.deepEqual(store.getAgentEvents('a1').map(e => e.id), [e1.id, e2.id]);
    assert.deepEqual(store.getEvents(0, 2).map(e => e.id), [e2.id, e3.id], 'a limit gives the newest events');
    assert.equal(store.getEvents(0, 0).length, 0);
  });

  test(`${kind}: search finds events by text, agent and type`, () => {
    store.createAgent(mkAgent('a4', { name: 'Zoe' }));
    const s1 = store.appendEvent({ type: 'output', text: 'Refactoring utils' }, 'a4');
    const s2 = store.appendEvent({ type: 'output', text: 'the utils are refactored' }, 'a4');
    const s3 = store.appendEvent({ type: 'error', text: 'utils exploded' }, 'a4');
    store.appendEvent({ type: 'output', text: 'unrelated text' }, 'a1');

    assert.equal(store.searchEvents({ agentId: 'a4' }).length, 3);
    assert.deepEqual(store.searchEvents({ agentId: 'a4' }).map(e => e.id), [s3.id, s2.id, s1.id], 'newest first');
    assert.equal(store.searchEvents({ q: 'utils' }).length, 3);
    assert.equal(store.searchEvents({ q: 'UTILS' }).length, 3, 'search ignores case');
    assert.equal(store.searchEvents({ q: 'uti' }).length, 3, 'a short query still matches');
    assert.equal(store.searchEvents({ q: 'unrelated' }).length, 1);
    assert.equal(store.searchEvents({ q: 'nothing here' }).length, 0);
    assert.equal(store.searchEvents({ q: '%' }).length, 0, 'a lone % is not a wildcard');
    assert.equal(store.searchEvents({ agentId: 'a4', types: ['error'] }).length, 1);
    assert.equal(store.searchEvents({ agentId: 'a4', types: ['output'] }).length, 2);
    assert.equal(store.searchEvents({ agentId: 'a4', limit: 2 }).length, 2);
    assert.ok(store.searchEvents({ before: s3.id }).every(e => e.id < s3.id), 'before pages backwards');
  });

  test(`${kind}: stats and usage add up`, () => {
    store.appendEvent({ type: 'usage', data: { input: 100, output: 20, cost: 0.5 } }, 'a1');
    store.appendEvent({ type: 'usage', data: { input: 50, output: 10, cost: 0.25 } }, 'a1');
    const stats = store.eventStats().find(s => s.agentId === 'a1')!;
    assert.ok(stats.count >= 2, 'every event is counted');
    assert.ok(stats.lastTs > 0);
    const usage = store.usageTotals().find(u => u.agentId === 'a1')!;
    assert.equal(usage.turns, 2);
    assert.equal(usage.input, 150);
    assert.equal(usage.output, 30);
    assert.equal(Math.round(usage.cost! * 100) / 100, 0.75);
  });

  test(`${kind}: a server that died leaves no agent thinking`, () => {
    store.createAgent(mkAgent('b1', { status: 'working', activity: 'editing' }));
    assert.ok(store.resetBusyAgents() >= 1);
    assert.equal(store.getAgent('b1')!.status, 'idle');
  });

  test(`${kind}: pruning keeps the event types it is told to keep`, () => {
    const home2 = mkdtempSync(join(tmpdir(), `agentix-contract-prune-${kind}-`));
    const s2 = createStore(home2, kind, { history: false });
    s2.createAgent(mkAgent('p1'));
    s2.appendEvent({ type: 'output', text: 'keep me' }, 'p1');
    s2.appendEvent({ type: 'error', text: 'drop me' }, 'p1');
    s2.appendEvent({ type: 'usage', data: { input: 1 } }, 'p1');
    assert.equal(s2.pruneEvents(Date.now() + 1000, ['output']), 2);
    assert.deepEqual(s2.getEvents().map(e => e.type), ['output']);
  });
}

contract('sqlite');
contract('json');
