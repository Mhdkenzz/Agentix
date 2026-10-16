// HTTP + SSE end to end, plus the real CLI binary (`agentix watch`, `ls`, `spawn`).
import { TMP } from './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
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

const json = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
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
