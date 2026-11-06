// The API can be locked with a token, and no client can pull the whole event history in one go.
import './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { ServerResponse } from 'node:http';

process.env.AGENTIX_TOKEN = 'test-token';
process.env.AGENTIX_SSE_MAX_REPLAY = '25';
const { startServer } = await import('../src/index.ts');
const { store } = await import('../src/store.ts');

const { server, sessionManager, port } = await startServer(0);
const base = `http://127.0.0.1:${port}`;
after(async () => { await sessionManager.shutdown(); server.closeAllConnections(); server.close(); });

test('with AGENTIX_TOKEN set the API needs the token', async () => {
  const none = await fetch(base + '/api/agents');
  assert.equal(none.status, 401);
  const wrong = await fetch(base + '/api/agents', { headers: { 'x-agentix-token': 'nope' } });
  assert.equal(wrong.status, 401);
  const right = await fetch(base + '/api/agents', { headers: { 'x-agentix-token': 'test-token' } });
  assert.equal(right.status, 200);
  const queryTokenOnRest = await fetch(base + '/api/agents?token=test-token');
  assert.equal(queryTokenOnRest.status, 401, 'query tokens are accepted only for event streams');
  assert.equal((await fetch(base + '/api/health')).status, 401, 'storage diagnostics require the API token too');
  const health = await fetch(base + '/api/health', { headers: { 'x-agentix-token': 'test-token' } });
  assert.equal(health.status, 200);
  assert.equal((await health.json() as any).ok, true);
  // the dashboard itself stays reachable, so the browser can load it
  assert.equal((await fetch(base + '/')).status, 200);
});

test('JSON APIs reject null, array, and oversized multibyte bodies as client errors', async () => {
  const headers = { 'Content-Type': 'application/json', 'x-agentix-token': 'test-token' };
  for (const body of ['null', '[]', '"value"']) {
    const response = await fetch(base + '/api/settings', { method: 'PATCH', headers, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error, 'JSON body must be an object');
  }
  const multibyte = JSON.stringify({ text: 'é'.repeat(600_000) });
  const tooLarge = await fetch(base + '/api/context/brief', { method: 'PUT', headers, body: multibyte });
  assert.equal(tooLarge.status, 413);
});

test('JSON API preserves UTF-8 characters split across request chunks', async () => {
  const payload = Buffer.from(JSON.stringify({ text: 'split café survives' }));
  const mark = Buffer.from('é');
  const index = payload.indexOf(mark);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(`${base}/api/context/brief`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-agentix-token': 'test-token' },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, index + 1)); // split between the two bytes encoding “é”
    setTimeout(() => req.end(payload.subarray(index + 1)), 10);
  });
  assert.equal(response.status, 200);
  const context = await fetch(base + '/api/context', { headers: { 'x-agentix-token': 'test-token' } }).then(r => r.json()) as any;
  assert.equal(context.brief, 'split café survives');
});

test('the event stream does not replay the whole database in one go', async () => {
  for (let i = 0; i < 30; i++) store.appendEvent({ type: 'output', text: `filler event ${i}` }, 'a_filler');

  /** Read the stream until `want` events have arrived (the stream itself never ends). */
  const count = async (path: string, want: number) => {
    const res = await fetch(base + path);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let n = 0;
    try {
      for (;;) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>(r => { timer = setTimeout(() => r(null), 3000); });
        const chunk = await Promise.race([reader.read(), timeout]);
        clearTimeout(timer);
        if (!chunk || chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        n = (buf.match(/^id: /gm) || []).length;
        if (n >= want) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return n;
  };

  assert.equal(await count('/api/stream?tail=100000&token=test-token', 25), 25, 'a replay is capped');
  assert.equal(await count('/api/stream?tail=5&token=test-token', 5), 5, 'a small tail is honoured');
  assert.equal(await count('/api/stream?after=1&token=test-token', 25), 25, 'a resume is capped too');
});

test('a slow SSE client is disconnected as soon as the response applies backpressure', async () => {
  const originalWrite = ServerResponse.prototype.write;
  let eventWrites = 0;
  ServerResponse.prototype.write = function(this: ServerResponse, chunk: any, ...args: any[]) {
    const result = originalWrite.call(this, chunk, ...args as [any]);
    if (String(chunk).startsWith('id: ')) {
      eventWrites++;
      if (eventWrites === 1) return false;
    }
    return result;
  } as typeof ServerResponse.prototype.write;
  try {
    const response = await fetch(`${base}/api/stream?tail=0&token=test-token`);
    assert.equal(response.status, 200);
    await new Promise(resolve => setTimeout(resolve, 20)); // let the server attach the live subscriber
    sessionManager.emit('slow_client', { type: 'output', text: 'first live event' });
    sessionManager.emit('slow_client', { type: 'output', text: 'second live event' });
    assert.equal(eventWrites, 1, 'no more events are buffered after backpressure');
    await response.body?.cancel().catch(() => {});
  } finally {
    ServerResponse.prototype.write = originalWrite;
  }
});
