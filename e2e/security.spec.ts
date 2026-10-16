// Other websites open in the same browser must not reach the API.
import { test, expect } from '@playwright/test';

test('a foreign Origin gets 403 from the API', async ({ request, baseURL }) => {
  const evil = { Origin: 'https://evil.example' };
  const get = await request.get('/api/agents', { headers: evil });
  expect(get.status()).toBe(403);

  const post = await request.post('/api/agents', { headers: evil, data: { kind: 'codex', name: 'Mallory' } });
  expect(post.status()).toBe(403);

  // Our own origin is fine, and Mallory was never created.
  const ok = await request.get('/api/agents', { headers: { Origin: baseURL! } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).agents.some((a: { name: string }) => a.name === 'Mallory')).toBe(false);
});
