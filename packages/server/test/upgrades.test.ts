// Worktree per worker, task board, usage totals, event retention and embedding search.
import { TMP, waitFor } from './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();

const REPO = join(TMP, 'repo');
mkdirSync(join(REPO, 'src'), { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
writeFileSync(join(REPO, 'README.md'), 'hello\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-q', '-m', 'init');

test('a worker started in a git repo gets its own worktree and branch; merge, discard, remove', async () => {
  const { body } = await json('/api/agents', 'POST', { kind: 'mock', name: 'Rook', cwd: join(REPO, 'src') });
  const a = body.agent;
  assert.ok(a.worktree, 'has a worktree');
  assert.match(a.worktree.branch, /^agentix\/rook-a_/);
  assert.equal(a.cwd, join(a.worktree.path, 'src'), 'same subfolder inside the worktree');
  assert.ok(git(REPO, 'branch', '--list', a.worktree.branch));

  // the worker edits files (the mock adapter doesn't, so write them as it would)
  writeFileSync(join(a.cwd, 'app.js'), 'console.log(1)\n');
  writeFileSync(join(a.worktree.path, 'README.md'), 'hello from Rook\n');
  let st = (await json(`/api/agents/${a.id}/worktree`)).body;
  assert.deepEqual(st.files.map((f: any) => `${f.status} ${f.path}`).sort(), ['A src/app.js', 'M README.md']);
  assert.equal(st.target, 'main');
  assert.match(st.diff, /hello from Rook/);
  assert.equal(readFileSync(join(REPO, 'README.md'), 'utf8'), 'hello\n', 'the main checkout is untouched');
  assert.equal(git(a.worktree.path, 'diff', '--cached', '--name-only'), '', 'looking at the diff staged nothing');

  const m = await json(`/api/agents/${a.id}/worktree/merge`, 'POST');
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.into, 'main');
  assert.equal(readFileSync(join(REPO, 'README.md'), 'utf8'), 'hello from Rook\n');
  assert.ok(existsSync(join(REPO, 'src', 'app.js')));
  st = (await json(`/api/agents/${a.id}/worktree`)).body;
  assert.equal(st.files.length, 0, 'after a merge only new work shows');
  assert.equal((await json(`/api/agents/${a.id}/worktree/merge`, 'POST')).status, 409, 'nothing to merge');

  writeFileSync(join(a.cwd, 'junk.txt'), 'x');
  assert.equal((await json(`/api/agents/${a.id}/worktree/discard`, 'POST')).status, 200);
  assert.equal((await json(`/api/agents/${a.id}/worktree`)).body.files.length, 0);

  // removing keeps unmerged work as a commit on the branch and deletes the folder
  writeFileSync(join(a.cwd, 'wip.js'), 'wip\n');
  await json(`/api/agents/${a.id}`, 'DELETE');
  assert.ok(!existsSync(a.worktree.path), 'worktree folder removed');
  assert.match(git(REPO, 'show', '--stat', a.worktree.branch), /wip\.js/, 'work kept on the branch');

  // a worker that asked for no worktree, and one outside any repo
  const plain = (await json('/api/agents', 'POST', { kind: 'mock', cwd: REPO, worktree: false })).body.agent;
  assert.equal(plain.worktree, undefined);
  assert.equal(plain.cwd, REPO);
  updateSettings({ worktrees: false });
  assert.equal((await json('/api/agents', 'POST', { kind: 'mock', cwd: REPO })).body.agent.worktree, undefined);
  updateSettings({ worktrees: true });
  assert.equal((await json(`/api/agents/${plain.id}/worktree`)).status, 404);
});

test('task board: coordinator plans with @@task, spawned workers move their tasks, kenz edits them', async () => {
  const coord = (await json('/api/agents', 'POST', { kind: 'mock', role: 'coordinator', name: 'Boss', replace: true })).body.agent;
  await sm.steerAgent(coord.id, 'plan\nsay: @@task :: Write the docs\nsay: @@spawn kind=mock name=Builder worktree=no :: Build the app');
  const builder = await waitFor(() => sm.getAgents().find(a => a.name === 'Builder'), 5000, 'Builder spawned');
  assert.equal(builder.worktree, undefined);
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
