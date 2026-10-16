// The old JSON store is imported into SQLite on first start.
import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('agentix.json from the previous version is imported once, then renamed', async () => {
  const home = process.env.AGENTIX_HOME!;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'agentix.json'), JSON.stringify({
    agents: [{ id: 'a_old', name: 'Rook', kind: 'mock', role: 'worker', avatarId: 0, cwd: '/tmp', status: 'thinking', activity: 'thinking...', createdAt: 1 }],
    events: [{ id: 41, agentId: 'a_old', type: 'steer', from: 'user', text: 'old steer', ts: 2 }],
    nextEventId: 42,
  }));

  const { store } = await import('../src/store.ts');
  assert.equal(store.getStoreType(), 'sqlite');
  assert.equal(store.getAgent('a_old')?.name, 'Rook');
  const [e] = store.getAgentEvents('a_old');
  assert.equal(e.id, 41);
  assert.equal(e.from, 'user');
  assert.ok(store.appendEvent({ type: 'output', text: 'new' }, 'a_old').id > 41, 'new ids continue after imported ones');
  assert.ok(!existsSync(join(home, 'agentix.json')));
  assert.ok(existsSync(join(home, 'agentix.json.imported')));
});
