import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapServer } from '../src/server-bootstrap.ts';

async function close(server: import('node:http').Server, sessionManager: import('../src/sessions.ts').SessionManager) {
  await sessionManager.shutdown();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('a second server cannot reuse the same data folder on another port', async () => {
  const first = await bootstrapServer(0);
  try {
    await assert.rejects(bootstrapServer(0), /already using this data folder/);
    const response = await fetch(`http://127.0.0.1:${first.port}/api/agents`);
    assert.equal(response.status, 200, 'the original server remains available');
  } finally { await close(first.server, first.sessionManager); }

  const { store } = await import('../src/store.ts');
  const resetBusyAgents = store.resetBusyAgents;
  store.resetBusyAgents = () => { throw new Error('simulated startup database failure'); };
  await assert.rejects(bootstrapServer(0), /simulated startup database failure/);
  store.resetBusyAgents = resetBusyAgents;

  const second = await bootstrapServer(0);
  await close(second.server, second.sessionManager);
});
