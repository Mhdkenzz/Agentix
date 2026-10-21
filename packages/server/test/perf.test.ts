// Perf regression test: the shared-context search and the event writes must stay fast, and the
// server must never freeze while they run.
//
// The numbers here are deliberately generous (a slow CI machine is not a bug), but the shape of
// the curves is what this test is really about:
//   - a search that re-reads and re-counts every file on every query gets slower with the corpus
//     (it used to take 2.7 s and block the event loop for 2.7 s on a 31 MB repo);
//   - a store that rewrites everything on every event grows quadratically (the old JSON store
//     wrote 254 ms for the first 1000 events and 893 ms for the next 1000).
import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSettings } from '../src/settings.ts';
import { searchContext } from '../src/context.ts';
import { createStore } from '../src/store.ts';
import { flushHistory } from '../src/history.ts';
import type { Agent } from '../../shared/src/types.ts';

const agent = (id: string): Agent => ({
  id, name: id, kind: 'mock', role: 'worker', avatarId: 0, cwd: '/tmp',
  status: 'idle', activity: 'idle', createdAt: 1,
});

test('a search over a big folder is fast and does not block the event loop', async () => {
  const corpus = mkdtempSync(join(tmpdir(), 'agentix-perf-'));
  const files = 150;
  for (let i = 0; i < files; i++) {
    const body = Array.from({ length: 8 * 32 }, (_, j) =>
      `line ${j} of file ${i} about the authentication service and the retry policy with backoff`).join('\n');
    writeFileSync(join(corpus, `mod${i}.ts`), body);
  }
  updateSettings({ contextPaths: [corpus] });

  // A counter that only ticks when the event loop is free: it stays at zero when the search
  // hogs the loop, which is what the server used to do.
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);

  const started = performance.now();
  const hits = await searchContext('authentication retry policy backoff', { limit: 5, sources: ['file'] });
  const cold = performance.now() - started;

  clearInterval(timer);
  assert.ok(hits.length > 0, 'the corpus is searched');
  assert.ok(cold < 5000, `the cold search took ${Math.round(cold)} ms (budget 5000 ms)`);
  assert.ok(ticks > 0, 'the event loop kept running while the search worked');

  // The second search reads the same files again: the file cache must make it much cheaper.
  let warm = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await searchContext('authentication retry policy backoff', { limit: 5, sources: ['file'] });
    warm = Math.min(warm, performance.now() - t);
  }
  assert.ok(warm < cold, `the warm search (${Math.round(warm)} ms) should be faster than the cold one (${Math.round(cold)} ms)`);
  assert.ok(warm < 2000, `the warm search took ${Math.round(warm)} ms (budget 2000 ms)`);
  updateSettings({ contextPaths: [] });
});

test('appending events does not get slower as the log grows', async () => {
  for (const kind of ['json', 'sqlite'] as const) {
    const home = mkdtempSync(join(tmpdir(), `agentix-perf-${kind}-`));
    const store = createStore(home, kind, { history: false });
    store.createAgent(agent('a1'));

    const batch = async (from: number, to: number) => {
      const t = performance.now();
      for (let i = from; i < to; i++) store.appendEvent({ type: 'output', text: `event ${i} with a bit of text` }, 'a1');
      return performance.now() - t;
    };
    const first = await batch(0, 1000);
    const second = await batch(1000, 2000);
    // A store that rewrites everything on every write gets twice as slow in the second batch.
    assert.ok(second < first * 2.5 + 20,
      `${kind}: the second 1000 events took ${Math.round(second)} ms, the first ${Math.round(first)} ms (too much growth)`);

    // ...and the events are all there.
    assert.equal(store.getEvents().length, 2000);
    assert.equal(store.searchEvents({ q: 'event 1500' }).length, 1);
  }
});

test('the history files are written in batches, not once per event', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentix-perf-history-'));
  const store = createStore(home, 'sqlite');   // with the history wrapper
  store.createAgent(agent('a1'));

  const started = performance.now();
  for (let i = 0; i < 200; i++) store.appendEvent({ type: 'output', text: `event ${i}` }, 'a1');
  const elapsed = performance.now() - started;

  // The writes are buffered: right after the appends the file cannot hold a line per event yet.
  const file = join(home, 'history', 'a1.jsonl');
  const linesNow = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.ok(linesNow < 200 || elapsed > 150,
    `the history file already held ${linesNow} lines: every event is written on its own`);

  await flushHistory();
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 200, 'every event ends up in the history file');
  assert.equal(JSON.parse(lines[0]).text, 'event 0');
});
