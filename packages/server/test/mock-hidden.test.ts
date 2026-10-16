// The mock adapter is test-only: hidden without AGENTIX_MOCK=1, and leftover mock agents are dropped.
import { waitFor } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { getAdapter, getAdapterNames } from '../src/adapters/index.ts';
import { store } from '../src/store.ts';

test('mock is hidden without AGENTIX_MOCK=1 and leftover mock agents are removed at startup', async () => {
  const sm = new SessionManager(new EventBus());
  const old = sm.createAgent('mock', { prompt: 'hello' });
  await waitFor(() => !sm.isRunning(old.id), 5000, 'mock turn done');
  delete process.env.AGENTIX_MOCK;
  try {
    assert.equal(getAdapter('mock'), undefined);
    assert.ok(!getAdapterNames().includes('mock'));
    assert.ok(getAdapterNames().includes('codex'));
    new SessionManager(new EventBus());
    assert.equal(store.getAgent(old.id), undefined);
    assert.deepEqual(store.getAgentEvents(old.id), []);
  } finally {
    process.env.AGENTIX_MOCK = '1';
  }
});
