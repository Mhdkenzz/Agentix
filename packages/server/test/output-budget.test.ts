import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TMP, WORK } from './helpers.ts';
import { runCli } from '../src/adapters/proc.ts';
import { updateSettings } from '../src/settings.ts';
import type { AdapterContext } from '../src/adapters/types.ts';

function writeCli(name: string, script: string): string {
  const path = join(TMP, name);
  writeFileSync(path, `#!/bin/bash\n${script}\n`);
  chmodSync(path, 0o755);
  updateSettings({ cliPaths: { codex: path } });
  return path;
}

function context(): AdapterContext {
  return {
    agent: { id: 'output-budget', kind: 'codex', cwd: WORK },
    signal: new AbortController().signal,
    emit() {},
    setNativeSessionId() {},
  } as unknown as AdapterContext;
}

test('CLI stdout is stopped before parsing once a turn exceeds its output budget', async () => {
  const previous = process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES;
  process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES = String(1024 * 1024);
  writeCli('noisy-codex', "head -c 1100000 /dev/zero | tr '\\0' x | fold -w 1000");
  try {
    await assert.rejects(runCli(context(), 'codex', [], () => assert.fail('oversized output must not be parsed')), /turn output limit/);
  } finally {
    updateSettings({ cliPaths: {} });
    if (previous === undefined) delete process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES;
    else process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES = previous;
  }
});

test('one giant stdout line is rejected by its line limit, before the total turn budget', async () => {
  const previous = process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES;
  delete process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES;
  writeCli('giant-line-codex', "head -c 1100000 /dev/zero | tr '\\0' x");
  try {
    await assert.rejects(runCli(context(), 'codex', [], () => assert.fail('oversized line must not be parsed')), /1 MiB line limit/);
  } finally {
    updateSettings({ cliPaths: {} });
    if (previous !== undefined) process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES = previous;
  }
});

test('stderr also counts against the combined turn output budget', async () => {
  const previous = process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES;
  process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES = String(1024 * 1024);
  writeCli('noisy-stderr-codex', "head -c 1100000 /dev/zero | tr '\\0' x | fold -w 1000 >&2");
  try {
    await assert.rejects(runCli(context(), 'codex', [], () => {}), /turn output limit/);
  } finally {
    updateSettings({ cliPaths: {} });
    if (previous === undefined) delete process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES;
    else process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES = previous;
  }
});

test('stderr parser receives its final line even without a trailing newline', async () => {
  writeCli('unterminated-stderr-codex', "printf 'session_id: tail-id' >&2");
  const lines: string[] = [];
  try {
    await runCli(context(), 'codex', [], () => {}, line => lines.push(line));
    assert.deepEqual(lines, ['session_id: tail-id']);
  } finally { updateSettings({ cliPaths: {} }); }
});

test('agent CLI subprocesses never inherit the Agentix API token', async () => {
  const previous = process.env.AGENTIX_TOKEN;
  process.env.AGENTIX_TOKEN = 'private-dashboard-token';
  writeCli('token-check-codex', 'if [ -n "$AGENTIX_TOKEN" ]; then echo leaked; else echo clean; fi');
  const lines: string[] = [];
  try {
    await runCli({ ...context(), env: { AGENTIX_TOKEN: 'also-private' } }, 'codex', [], line => lines.push(line));
    assert.deepEqual(lines, ['clean']);
  } finally {
    updateSettings({ cliPaths: {} });
    if (previous === undefined) delete process.env.AGENTIX_TOKEN;
    else process.env.AGENTIX_TOKEN = previous;
  }
});

test('a child left behind by an exited CLI is stopped even after output pipes close', async () => {
  const pidFile = join(TMP, 'orphan-cli-child.pid');
  writeCli('parent-exits-codex', `sleep 30 & echo $! > '${pidFile}'; exit 0`);
  try {
    await runCli(context(), 'codex', [], () => {});
    assert.ok(existsSync(pidFile), 'the child process started');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    await new Promise(resolve => setTimeout(resolve, 50));
    let state = '';
    try { state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] ?? ''; } catch { /* exited */ }
    assert.ok(!state || state === 'Z', 'the private process group child was stopped');
  } finally { updateSettings({ cliPaths: {} }); }
});

test('an exited CLI cannot leave a helper running after it redirects both pipes', async () => {
  const pidFile = join(TMP, 'redirected-cli-child.pid');
  writeCli('redirected-parent-codex', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`);
  try {
    await runCli(context(), 'codex', [], () => {});
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    let stopped = false;
    for (let i = 0; i < 150; i++) {
      let state = '';
      try { state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] ?? ''; } catch { stopped = true; break; }
      if (state === 'Z') { stopped = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(stopped, 'the orphan helper is stopped without waiting for another server start');
  } finally { updateSettings({ cliPaths: {} }); }
});
