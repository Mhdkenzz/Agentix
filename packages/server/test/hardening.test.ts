// The API can be locked with a token, and no client can pull the whole event history in one go.
import './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

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
  // the dashboard itself stays reachable, so the browser can load it
  assert.equal((await fetch(base + '/')).status, 200);
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
