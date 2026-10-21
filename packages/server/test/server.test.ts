// HTTP + SSE end to end, plus the real CLI binary (`agentix watch`, `ls`, `spawn`).
import { TMP } from './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/index.ts';
import { store } from '../src/store.ts';

const CLI = fileURLToPath(new URL('../../cli/src/agentix.ts', import.meta.url));
const run = promisify(execFile);

// A stale "thinking" agent from a previous run must be reset when the server starts.
store.createAgent({ id: 'a_stale', name: 'Stale', kind: 'mock', role: 'worker', avatarId: 0, cwd: TMP, status: 'thinking', activity: 'thinking...', createdAt: 1 });

const { server, sessionManager, port } = await startServer(0);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENTIX_URL: base };
after(async () => { await sessionManager.shutdown(); server.closeAllConnections(); server.close(); });

const json = async (path: string, method = 'GET', body?: any) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};

/** Collect SSE messages (raw `event:` names + parsed data) until `done` says stop. */
async function collect(path: string, done: (msgs: { event: string; id: string; data: any }[]) => boolean, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(base + path, { headers, signal: ctrl.signal });
  const msgs: { event: string; id: string; data: any }[] = [];
  let buf = '';
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    for await (const chunk of res.body as any) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const get = (f: string) => block.split('\n').find(l => l.startsWith(f + ': '))?.slice(f.length + 2);
        if (get('data')) msgs.push({ event: get('event')!, id: get('id')!, data: JSON.parse(get('data')!) });
      }
      if (done(msgs)) break;
    }
  } catch { /* aborted */ } finally { clearTimeout(timer); ctrl.abort(); }
  return msgs;
}

test('server start resets agents stuck mid-turn', async () => {
  const { body } = await json('/api/agents/a_stale');
  assert.equal(body.agent.status, 'idle');
});

test('REST errors: 404, 400, 409', async () => {
  assert.equal((await json('/api/agents/nope')).status, 404);
  assert.equal((await json('/api/agents', 'POST', { kind: 'bogus' })).status, 400);
  assert.equal((await json('/api/agents', 'POST', { kind: 'mock', role: 'ceo' })).status, 201);
  const dup = await json('/api/agents', 'POST', { kind: 'mock', role: 'ceo' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already the ceo/);
});

test('malformed URL encoding returns 400 without taking down the server', async () => {
  const r = await fetch(base + '/api/%');
  assert.equal(r.status, 400);
  assert.match((await r.json() as any).error, /Malformed URL encoding/);
  assert.equal((await json('/api/agents')).status, 200, 'server remains available');
});

test('/api/stream delivers named events live; Last-Event-ID resumes', async () => {
  const streaming = collect('/api/stream?tail=0', ms => ms.some(m => m.data.type === 'output'));
  await new Promise(r => setTimeout(r, 100));
  const { body } = await json('/api/agents', 'POST', { kind: 'mock', prompt: 'sse' });
  const msgs = await streaming;
  const mine = msgs.filter(m => m.data.agentId === body.agent.id);
  assert.deepEqual(mine.map(m => m.event), mine.map(m => m.data.type), 'event name = type');
  assert.equal(mine[0].event, 'agent.created');
  assert.ok(mine.some(m => m.event === 'tool'));

  const cut = mine[2].id;
  const resumed = await collect(`/api/agents/${body.agent.id}/stream`, ms => ms.some(m => m.data.type === 'output'), { 'Last-Event-ID': cut });
  assert.ok(resumed.length > 0);
  assert.ok(resumed.every(m => m.data.id > Number(cut)));
  assert.equal(resumed.filter(m => m.data.agentId !== body.agent.id).length, 0);
});

test('serves the dashboard: assets, SPA fallback, no path escape', async () => {
  const root = await fetch(base + '/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type')!, /text\/html/);
  assert.match(await root.text(), /id="root"/);
  const js = await fetch(base + '/assets/app-123.js');
  assert.match(js.headers.get('content-type')!, /javascript/);
  assert.match(js.headers.get('cache-control')!, /immutable/);
  assert.match(await (await fetch(base + '/history')).text(), /id="root"/, 'client routes get index.html');
  assert.doesNotMatch(await (await fetch(base + '/..%2fsecret.txt')).text(), /nope/);

  // A prefix-only check would allow a sibling such as dist-escape-xyz/secret.txt.
  const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const outside = mkdtempSync(join(dirname(webDist), 'dist-escape-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside dashboard root');
    const escaped = `/%2e%2e%2f${basename(outside)}/secret.txt`;
    const escapedResponse = await fetch(base + escaped);
    assert.equal(escapedResponse.status, 200);
    assert.match(await escapedResponse.text(), /id="root"/, 'traversal falls back to the SPA');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('GET /api/agents has lastEventId for stream?after=', async () => {
  const created = (await json('/api/agents', 'POST', { kind: 'mock' })).body.agent;
  const { body } = await json('/api/agents');
  const latest = (await json(`/api/agents/${created.id}/events`)).body.events.at(-1);
  assert.ok(latest && body.lastEventId >= latest.id);
});

test('GET /api/events searches text, filters by agent and type, pages with before', async () => {
  const a = (await json('/api/agents', 'POST', { kind: 'mock', name: 'Searchy' })).body.agent;
  await json(`/api/agents/${a.id}/steer`, 'POST', { text: 'find the 100%_Needle here' });
  await json(`/api/agents/${a.id}/interrupt`, 'POST');
  const hit = (await json('/api/events?q=100%25_needle')).body;
  assert.equal(hit.events.length, 1, 'case-insensitive, % and _ are literal');
  assert.equal(hit.events[0].agentId, a.id);
  assert.equal((await json('/api/events?q=100%25x')).body.events.length, 0);
  const mine = (await json(`/api/events?agent=${a.id}&type=steer,agent.created`)).body.events;
  assert.deepEqual(mine.map((e: any) => e.type), ['steer', 'agent.created'], 'newest first');
  const older = (await json(`/api/events?agent=${a.id}&before=${mine[0].id}`)).body.events;
  assert.ok(older.every((e: any) => e.id < mine[0].id));
  assert.ok(hit.stats.some((s: any) => s.agentId === a.id && s.count >= 2));
});

test('auto names are unique while names are free', async () => {
  const names: string[] = [];
  for (let i = 0; i < 5; i++) names.push((await json('/api/agents', 'POST', { kind: 'mock' })).body.agent.name);
  const all = (await json('/api/agents')).body.agents.map((a: any) => a.name);
  assert.equal(new Set(all).size, all.length);
});

test('CLI: spawn, ls and watch work against the server', async () => {
  const watch = spawn(process.execPath, [CLI, 'watch'], { env });
  let out = '';
  watch.stdout.on('data', d => { out += d; });
  watch.stderr.on('data', d => { out += d; });
  await new Promise(r => setTimeout(r, 400));

  const spawned = await run(process.execPath, [CLI, 'spawn', 'mock', '--name', 'Cli', '--avatar', '4', 'hello', 'from', 'cli'], { env });
  assert.match(spawned.stdout, /Spawned Cli \(a_\w+\)/);
  assert.match(spawned.stdout, /avatar: 4/);

  const end = Date.now() + 5000;
  while (!out.includes('Done: hello from cli') && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  watch.kill();
  assert.doesNotMatch(out, /EventSource|Error/);
  assert.match(out, /\[Cli a_\w+\]/);
  assert.match(out, /tool: reading README\.md/);
  assert.match(out, /output: Done: hello from cli/);

  const ls = await run(process.execPath, [CLI, 'ls'], { env });
  assert.match(ls.stdout, /Cli\s+mock\s+worker\s+idle/);
});

test('CLI: clear error when the server is down', async () => {
  const r = await run(process.execPath, [CLI, 'ls'], { env: { ...env, AGENTIX_URL: 'http://127.0.0.1:1' } }).catch(e => e);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /can't reach the agentix server/);
});

test('a second server on the same port fails cleanly without touching agents', async () => {
  const { body } = await json('/api/agents', 'POST', { kind: 'mock', prompt: 'busy' });
  await assert.rejects(startServer(port), /already in use/);
  const now = (await json(`/api/agents/${body.agent.id}`)).body.agent.status;
  assert.notEqual(now, 'idle', 'a failed second server must not reset the live one');
});

test('reset starts a clean first-run workspace', async () => {
  await json('/api/context/brief', 'PUT', { text: 'old brief' });
  await json('/api/context/notes', 'POST', { text: 'old note' });
  await json('/api/tasks', 'POST', { title: 'old task' });
  await json('/api/agents', 'POST', { kind: 'mock', name: 'Reset me' });

  const reset = await json('/api/reset', 'POST');
  assert.equal(reset.status, 200);
  assert.equal(reset.body.settings.setupDone, false);
  assert.deepEqual((await json('/api/agents')).body.agents, []);
  assert.deepEqual((await json('/api/tasks')).body.tasks, []);
  const context = (await json('/api/context')).body;
  assert.equal(context.brief, '');
  assert.deepEqual(context.notes, []);
});
