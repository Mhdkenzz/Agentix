// Local-only access, permanent history, new/clear session, shared context (RAG) and the setup scan.
import { TMP, WORK, fakeCalls, waitFor } from './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startServer } from '../src/index.ts';
import { AGENTIX_HOME } from '../src/store.ts';
import { updateSettings } from '../src/settings.ts';
import { addNote, listNotes, searchContext, sharedContextBlock, chunk } from '../src/context.ts';
import { parseCommands } from '../src/commands.ts';
import { piAdapter } from '../src/adapters/pi.ts';

const SCAN_SCRIPT = fileURLToPath(new URL('../scripts/scan_clis.py', import.meta.url));

const { server, sessionManager: sm, port } = await startServer(0);
const base = `http://127.0.0.1:${port}`;
after(async () => { await sm.shutdown(); server.closeAllConnections(); server.close(); });

const json = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const idle = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)?.status === 'idle', 5000, `${id} idle`);

/** fetch() won't let us set Host, so use a raw request. */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end();
  });
}

test('only this machine can use the API: other origins and hosts get 403, no CORS headers', async () => {
  const evil = await json('/api/agents', 'POST', { kind: 'mock' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await json('/api/agents', 'GET', undefined, { origin: 'null' })).status, 403);
  assert.equal(await rawGet('/api/agents', 'evil.example:4317'), 403);
  assert.equal(await rawGet('/', 'attacker.com'), 403);
  // the dashboard itself, and the Vite dev server
  assert.equal(await rawGet('/api/agents', `localhost:${port}`), 200);
  assert.equal((await json('/api/agents', 'GET', undefined, { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await json('/api/agents', 'GET', undefined, { origin: 'http://localhost:5173' })).status, 200);
});

test('removing an agent keeps it, its events and its history files', async () => {
  const { body } = await json('/api/agents', 'POST', { kind: 'mock', name: 'Keeper', prompt: 'remember me' });
  const id = body.agent.id;
  await idle(id);
  assert.equal((await json(`/api/agents/${id}`, 'DELETE')).status, 200);

  const live = await json('/api/agents');
  assert.ok(!live.body.agents.some((a: any) => a.id === id));
  const all = await json('/api/agents?archived=1');
  const kept = all.body.agents.find((a: any) => a.id === id);
  assert.ok(kept?.archivedAt, 'archived agent listed');
  const events = await json(`/api/agents/${id}/events`);
  assert.equal(events.status, 200);
  assert.ok(events.body.events.some((e: any) => e.type === 'output' && e.text.includes('remember me')));
  assert.ok(events.body.events.some((e: any) => e.type === 'agent.removed'));
  assert.equal((await json(`/api/agents/${id}/steer`, 'POST', { text: 'x' })).status, 404);

  // the plain files on disk
  const agentsLog = readFileSync(join(AGENTIX_HOME, 'history', 'agents.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(agentsLog.filter(r => r.agent.id === id).map(r => r.op).filter(op => op !== 'session'), ['created', 'removed']);
  const ev = readFileSync(join(AGENTIX_HOME, 'history', `${id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(ev.map(e => e.id), events.body.events.map((e: any) => e.id));
});

test('new session drops the native session; clear also marks the cut for dashboards', async () => {
  const { body } = await json('/api/agents', 'POST', { kind: 'claude', role: 'coordinator', cwd: WORK, prompt: 'hello', replace: true });
  const id = body.agent.id;
  await idle(id);
  assert.equal(sm.getAgent(id)!.nativeSessionId, 'cl-fake-1');

  const r = await json(`/api/agents/${id}/session`, 'POST', { clear: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.event.type, 'session');
  assert.deepEqual(r.body.event.data, { clear: true });
  assert.equal(sm.getAgent(id)!.nativeSessionId, undefined);

  const before = fakeCalls('claude').length;
  await sm.steerAgent(id, 'fresh start');
  await idle(id);
  const args = fakeCalls('claude')[before];
  assert.ok(!args.includes('--resume'), 'no resume after a new session');
  assert.ok(args.some(a => a.includes('You are the COORDINATOR')), 'role instructions sent again');
  await json(`/api/agents/${id}`, 'DELETE');
});

test('@@remember parses with and without ::', () => {
  const { commands, errors } = parseCommands('ok\n@@remember :: tests live in packages/server/test\n- @@remember use pnpm\n@@remember');
  assert.deepEqual(commands.map(c => c.op === 'remember' && c.text), ['tests live in packages/server/test', 'use pnpm']);
  assert.equal(errors.length, 1);
});

test('notes are saved once and found by keyword search', () => {
  assert.ok(addNote('The database migrations live in db/migrations and run with make migrate', 'user'));
  assert.equal(addNote('the database migrations live in db/migrations and run with make migrate'), undefined);
  addNote('Frontend uses Tailwind and dark mode only');
  const hits = searchContext('how do I run the database migrations?');
  assert.equal(hits[0].source, 'note');
  assert.match(hits[0].text, /make migrate/);
  assert.equal(searchContext('').length, 0);
  assert.ok(chunk('a'.repeat(2500)).every(c => c.length <= 1000));
});

test('workers get the [SHARED CONTEXT] block and can add to it with @@remember', async () => {
  updateSettings({ sharedContext: true });
  const docs = join(TMP, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'deploy.md'), '# Deploying\n\nThe staging server deploys with ./scripts/ship.sh --staging');
  updateSettings({ contextPaths: [docs] });
  const brief = await json('/api/context/brief', 'PUT', { text: 'We are building a todo app. Keep it simple.' });
  assert.equal(brief.status, 200);

  const search = await json('/api/context/search?q=deploy%20staging');
  assert.equal(search.body.hits[0].source, 'file');

  const block = sharedContextBlock(sm.getAgents()[0] ?? ({ id: 'x' } as any), 'deploy to staging');
  assert.match(block, /todo app/);
  assert.match(block, /ship\.sh --staging/);

  // a real worker turn: the fake codex receives the block in its prompt
  const w = (await json('/api/agents', 'POST', { kind: 'codex', cwd: WORK, prompt: 'deploy to staging' })).body.agent;
  await idle(w.id);
  // the prompt is the last argument; it spans lines, so read the raw log (args are NUL-separated)
  const prompt = readFileSync(join(TMP, 'codex.args'), 'utf8').split('\0').filter(a => a.includes('deploy to staging')).at(-1)!;
  assert.match(prompt, /^\[SHARED CONTEXT\]/);
  assert.match(prompt, /ship\.sh/);
  assert.match(prompt, /\[END SHARED CONTEXT\]\n\ndeploy to staging$/);

  // a worker's @@remember line becomes a note everyone sees
  const m = (await json('/api/agents', 'POST', { kind: 'mock', prompt: 'x\nsay: @@remember :: The API key lives in .env.local' })).body.agent;
  await idle(m.id);
  assert.ok(listNotes().some(n => n.text === 'The API key lives in .env.local' && n.from === m.id));
  const ctx = await json('/api/context');
  assert.match(ctx.body.brief, /todo app/);
  assert.ok(ctx.body.notes.length >= 3);

  const note = (await json('/api/context/notes', 'POST', { text: 'kenz likes short answers' })).body.note;
  assert.equal((await json(`/api/context/notes/${note.id}`, 'DELETE')).status, 200);
  assert.equal((await json(`/api/context/notes/${note.id}`, 'DELETE')).status, 404);
  assert.ok(existsSync(join(AGENTIX_HOME, 'context', 'notes.jsonl')));
  updateSettings({ sharedContext: false, contextPaths: [] });
});

test('setup scan finds the agent CLIs on this machine', async () => {
  const r = await json('/api/setup/scan');
  assert.equal(r.status, 200);
  const codex = r.body.found.find((f: any) => f.kind === 'codex');
  assert.ok(codex, 'fake codex found');
  assert.equal(codex.supported, true);
  assert.equal(codex.path, join(TMP, 'bin', 'codex'));
  assert.match(codex.version, /9\.9\.9-fake/);
  assert.ok(['python', 'node'].includes(r.body.scanner));
});

test('a different program called "pi" (Debian\'s digits-of-π tool) is not taken for the Pi coding agent', async () => {
  const other = join(TMP, 'other-pi');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'pi'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 1.3.6"; exit 0; fi\necho "Usage: pi [number of digits]"\n');
  chmodSync(join(other, 'pi'), 0o755);

  // the scan script, with only the impostor on PATH
  const out = await promisify(execFile)('python3', [SCAN_SCRIPT], { env: { ...process.env, PATH: `${other}:/usr/bin:/bin`, HOME: other } });
  assert.ok(!JSON.parse(out.stdout).found.some((f: any) => f.kind === 'pi'), 'impostor pi not offered');
  // with the real fake on PATH it is found
  assert.ok((await json('/api/setup/scan')).body.found.some((f: any) => f.kind === 'pi' && f.supported));

  // the adapter check behind Settings and New agent
  updateSettings({ cliPaths: { pi: join(other, 'pi') } });
  assert.equal((await piAdapter.detect()).installed, false);
  updateSettings({ cliPaths: {} });
  assert.equal((await piAdapter.detect()).installed, true);
});
