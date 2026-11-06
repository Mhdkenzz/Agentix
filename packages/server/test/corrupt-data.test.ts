import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTasks } from '../src/tasks.ts';
import { listPermissionRequests } from '../src/approvals.ts';
import { readPendingWork } from '../src/pending.ts';
import { getSettings } from '../src/settings.ts';
import { createStore } from '../src/store.ts';

test('malformed saved task, approval, and pending JSON is preserved instead of overwritten', () => {
  const home = process.env.AGENTIX_HOME!;
  const files = ['tasks.json', 'approvals.json', 'pending.json', 'settings.json'];
  for (const name of files) writeFileSync(join(home, name), 'null');

  assert.deepEqual(listTasks(), []);
  assert.deepEqual(listPermissionRequests(), []);
  assert.equal(readPendingWork(), undefined);
  assert.equal(getSettings().defaultKind, 'codex');
  for (const name of files) {
    assert.equal(existsSync(join(home, name)), false, `${name} is removed from the active path`);
    assert.ok(readdirSync(home).some(file => file.startsWith(`${name}.corrupt-`)), `${name} has a recovery copy`);
  }

  const fallbackHome = join(home, 'corrupt-json-store');
  mkdirSync(fallbackHome, { recursive: true });
  const legacy = join(fallbackHome, 'agentix.json');
  const journal = join(fallbackHome, 'agentix-events.jsonl');
  writeFileSync(legacy, '{ truncated');
  writeFileSync(journal, `${JSON.stringify({ id: 7, agentId: 'a1', type: 'output', ts: 1, text: 'kept' })}\n`);
  assert.throws(() => createStore(fallbackHome, 'json'), /original file is preserved/);
  assert.equal(readFileSync(legacy, 'utf8'), '{ truncated', 'the damaged primary store is never overwritten');
  assert.equal(readFileSync(journal, 'utf8').includes('kept'), true, 'the event journal remains available for recovery');

  const badRowsHome = join(home, 'invalid-json-rows');
  mkdirSync(badRowsHome, { recursive: true });
  const badRows = join(badRowsHome, 'agentix.json');
  writeFileSync(badRows, JSON.stringify({ agents: [null], events: [] }));
  assert.throws(() => createStore(badRowsHome, 'json'), /invalid data shape/);
  assert.equal(readFileSync(badRows, 'utf8'), JSON.stringify({ agents: [null], events: [] }), 'invalid records remain recoverable');

  const failedWriteHome = join(home, 'failed-json-write');
  mkdirSync(failedWriteHome, { recursive: true });
  mkdirSync(join(failedWriteHome, 'agentix-events.jsonl')); // make append fail with EISDIR
  const failingStore = createStore(failedWriteHome, 'json', { history: false });
  failingStore.appendEvent({ type: 'output', text: 'in-memory only' }, 'a1');
  assert.match(failingStore.storageErrors().join('\n'), /Event journal: .*EISDIR/);
});
