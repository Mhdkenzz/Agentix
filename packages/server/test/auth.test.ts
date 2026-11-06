import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getApiToken } from '../src/auth.ts';

test('default API token is random, persisted, and owner-only', () => {
  const priorAuth = process.env.AGENTIX_AUTH;
  const priorToken = process.env.AGENTIX_TOKEN;
  delete process.env.AGENTIX_AUTH;
  delete process.env.AGENTIX_TOKEN;
  try {
    const token = getApiToken();
    const path = join(process.env.AGENTIX_HOME!, 'api-token');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(readFileSync(path, 'utf8').trim(), token);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(getApiToken(), token);
  } finally {
    if (priorAuth === undefined) delete process.env.AGENTIX_AUTH;
    else process.env.AGENTIX_AUTH = priorAuth;
    if (priorToken === undefined) delete process.env.AGENTIX_TOKEN;
    else process.env.AGENTIX_TOKEN = priorToken;
  }
});

test('an empty saved API token fails closed instead of disabling authentication', () => {
  const priorHome = process.env.AGENTIX_HOME;
  const priorAuth = process.env.AGENTIX_AUTH;
  const priorToken = process.env.AGENTIX_TOKEN;
  const home = mkdtempSync(join(tmpdir(), 'agentix-empty-token-'));
  process.env.AGENTIX_HOME = home;
  delete process.env.AGENTIX_AUTH;
  delete process.env.AGENTIX_TOKEN;
  writeFileSync(join(home, 'api-token'), ' \n');
  try {
    assert.throws(() => getApiToken(), /API token file is empty/);
  } finally {
    if (priorHome === undefined) delete process.env.AGENTIX_HOME;
    else process.env.AGENTIX_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.AGENTIX_AUTH;
    else process.env.AGENTIX_AUTH = priorAuth;
    if (priorToken === undefined) delete process.env.AGENTIX_TOKEN;
    else process.env.AGENTIX_TOKEN = priorToken;
  }
});

test('the server requires the saved token when no environment token is set', async () => {
  const priorAuth = process.env.AGENTIX_AUTH;
  const priorToken = process.env.AGENTIX_TOKEN;
  delete process.env.AGENTIX_AUTH;
  delete process.env.AGENTIX_TOKEN;
  const { startServer } = await import('../src/index.ts');
  const { server, sessionManager, port } = await startServer(0);
  try {
    const base = `http://127.0.0.1:${port}/api/agents`;
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { 'x-agentix-token': getApiToken() } })).status, 200);
  } finally {
    await sessionManager.shutdown();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (priorAuth === undefined) delete process.env.AGENTIX_AUTH;
    else process.env.AGENTIX_AUTH = priorAuth;
    if (priorToken === undefined) delete process.env.AGENTIX_TOKEN;
    else process.env.AGENTIX_TOKEN = priorToken;
  }
});
