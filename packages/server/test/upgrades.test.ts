// Task board, usage totals, event retention and embedding search.
import { TMP, waitFor } from './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer } from '../src/index.ts';
import { store } from '../src/store.ts';
import { updateSettings } from '../src/settings.ts';
import { addNote, searchContext, searchContextSmart } from '../src/context.ts';
import { pruneOldEvents } from '../src/retention.ts';
import { listTasks } from '../src/tasks.ts';

const { server, sessionManager: sm, port } = await startServer(0);
const base = `http://127.0.0.1:${port}`;
after(async () => { await sm.shutdown(); server.closeAllConnections(); server.close(); });

const json = async (path: string, method = 'GET', body?: any) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const idle = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)?.status === 'idle', 5000, `${id} idle`);
test('agents work directly in their configured folder and the old worktree API is unavailable', async () => {
  const { body } = await json('/api/agents', 'POST', { kind: 'mock', name: 'Rook', cwd: TMP, worktree: true });
  assert.equal(body.agent.cwd, TMP);
  assert.equal(body.agent.worktree, undefined, 'legacy worktree options are ignored');
  assert.equal((await json(`/api/agents/${body.agent.id}/worktree`)).status, 404);
});

test('task board: coordinator plans with @@task, spawned workers move their tasks, kenz edits them', async () => {
  const coord = (await json('/api/agents', 'POST', { kind: 'mock', role: 'coordinator', name: 'Boss', replace: true })).body.agent;
  await sm.steerAgent(coord.id, 'plan\nsay: @@task :: Write the docs\nsay: @@spawn kind=mock name=Builder :: Build the app');
  const builder = await waitFor(() => sm.getAgents().find(a => a.name === 'Builder'), 5000, 'Builder spawned');
  const docs = await waitFor(() => listTasks().find(t => t.title === 'Write the docs'), 3000, 'docs task');
  assert.equal(docs.status, 'todo');
  assert.equal(docs.by, coord.id);
  const build = await waitFor(() => listTasks().find(t => t.title === 'Build the app'), 3000, 'build task');
  assert.equal(build.owner, builder.id);
  assert.equal(build.status, 'doing', 'doing while the worker works');
  await idle(builder.id);
  await waitFor(() => listTasks().find(t => t.id === build.id)?.status === 'review', 3000, 'review after the turn');

  // the coordinator closes it; the digest lists open tasks
  await idle(coord.id);
  await sm.steerAgent(coord.id, `ok\nsay: @@task ${build.id} status=done :: looks good`);
  await waitFor(() => listTasks().find(t => t.id === build.id)?.status === 'done', 5000, 'done');
  const board = sm.teamDigest().split('Tasks (not done):')[1];
  assert.match(board, /t1 \[todo\] Write the docs/);
  assert.doesNotMatch(board, /Build the app/);
  assert.ok(store.searchEvents({ types: ['task'], limit: 50 }).some(e => (e.data as any)?.id === build.id));

  // the dashboard
  const t = (await json('/api/tasks', 'POST', { title: 'Review PR', owner: 'Builder' })).body.task;
  assert.equal(t.owner, builder.id);
  assert.equal((await json(`/api/tasks/${t.id}`, 'PATCH', { status: 'blocked' })).body.task.status, 'blocked');
  assert.equal((await json(`/api/tasks/${t.id}`, 'PATCH', { status: 'nope' })).status, 400);
  assert.equal((await json('/api/tasks', 'POST', { title: '' })).status, 400);
  assert.equal((await json(`/api/tasks/${t.id}`, 'DELETE')).status, 200);
  assert.equal((await json(`/api/tasks/${t.id}`, 'DELETE')).status, 404);
  // ids never repeat: deleting the newest task does not free its number
  const again = (await json('/api/tasks', 'POST', { title: 'Another one' })).body.task;
  assert.equal(again.id, 't4');
  await json(`/api/tasks/${again.id}`, 'DELETE');
  const yetAnother = (await json('/api/tasks', 'POST', { title: 'And one more' })).body.task;
  assert.equal(yetAnother.id, 't5', 'the id of a deleted task is not handed out again');
  await json(`/api/tasks/${yetAnother.id}`, 'DELETE');
  assert.ok((await json('/api/tasks')).body.tasks.length >= 2);
  await idle(coord.id);
});

test('usage totals per agent, all time and today', async () => {
  const a = (await json('/api/agents', 'POST', { kind: 'mock', name: 'Counter' })).body.agent;
  sm.emit(a.id, { type: 'usage', data: { input: 1000, output: 200, cacheRead: 50, cost: 0.01 } });
  sm.emit(a.id, { type: 'usage', data: { input: 500, output: 100 } });
  const { body } = await json('/api/usage');
  const mine = body.total.find((u: any) => u.agentId === a.id);
  assert.deepEqual({ ...mine }, { agentId: a.id, turns: 2, input: 1500, output: 300, cacheRead: 50, cacheWrite: 0, cost: 0.01 });
  assert.equal(body.today.find((u: any) => u.agentId === a.id).turns, 2);
});

test('embedding search finds a note by meaning; keyword search alone does not', async () => {
  // A stand-in for Ollama: words about signing in share one dimension, everything else hashes elsewhere.
  const SAME = new Set(['auth', 'authentication', 'login', 'sign', 'signin', 'oauth']);
  const vec = (t: string) => {
    const v = new Array(16).fill(0);
    for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (SAME.has(w)) v[0] += 3;
      else v[1 + ([...w].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 15)] += 1;
    }
    return v;
  };
  let calls = 0;
  const ollama = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls++;
    const { input } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ embeddings: input.map(vec) }));
  });
  await new Promise<void>(r => ollama.listen(0, '127.0.0.1', () => r()));
  after(() => ollama.close());
  const url = `http://127.0.0.1:${(ollama.address() as any).port}`;

  addNote('Users sign in on the login page with GitHub OAuth');
  addNote('The office floor is charcoal grey');
  assert.ok(!(await searchContext('auth flow', { sources: ['note'] })).some(h => /GitHub OAuth/.test(h.text)), 'keywords miss it');

  updateSettings({ embeddings: { provider: 'ollama', url, model: 'fake' } });
  const hits = await searchContextSmart('auth flow', { sources: ['note'] });
  assert.match(hits[0]?.text ?? '', /GitHub OAuth/);
  const before = calls;
  await searchContextSmart('auth flow', { sources: ['note'] });
  assert.equal(calls - before, 1, 'documents are embedded once, then cached (only the query is embedded again)');
  assert.deepEqual((await json('/api/context/embeddings/test', 'POST')).body, { ok: true, dimensions: 16 });

  // Ollama down: keyword results, and the error is reported
  updateSettings({ embeddings: { provider: 'ollama', url: 'http://127.0.0.1:9', model: 'fake' } });
  const r = await json('/api/context/search?q=office%20floor');
  assert.match(r.body.hits[0].text, /charcoal/);
  assert.ok(r.body.embeddingError);
  updateSettings({ embeddings: { provider: 'off', url, model: 'fake' } });
});

test('retention removes old events from the database but keeps agents, usage and tasks', async () => {
  const types = () => new Set(store.getEvents().map(e => e.type));
  assert.ok(types().has('output'));
  updateSettings({ retentionDays: 0 });
  assert.equal(pruneOldEvents(Date.now() + 365 * 86_400_000), 0, '0 = keep forever');
  updateSettings({ retentionDays: 30 });
  const removed = pruneOldEvents(Date.now() + 31 * 86_400_000);
  assert.ok(removed > 0);
  const left = types();
  assert.ok(!left.has('output') && !left.has('status'));
  assert.ok(left.has('usage') && left.has('task') && left.has('agent.created'));
  assert.equal((await json('/api/settings', 'PUT', { retentionDays: -1 })).status, 400);
});
