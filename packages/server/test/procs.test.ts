import './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTIX_HOME } from '../src/store.ts';
import { killOrphanRuns, registerRun, signalRunGroup } from '../src/procs.ts';

test('orphan cleanup ignores a reused PID whose start identity no longer matches', async () => {
  const child = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const pid = child.pid!;
  try {
    registerRun(pid, '/bin/sleep', 'test-agent');
    const path = join(AGENTIX_HOME, 'runs', `${pid}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(record.identity, 'registration stores a process identity');
    record.identity.startTime = `${record.identity.startTime}-stale`;
    writeFileSync(path, JSON.stringify(record));

    assert.equal(signalRunGroup(pid, 'SIGTERM'), false, 'a known stale identity is never bypassed by the in-memory record');
    assert.equal(await killOrphanRuns(), 0);
    process.kill(pid, 0);
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
  }
});

test('orphan cleanup can stop a surviving child after its verified CLI leader exits', async () => {
  const childPidFile = join(AGENTIX_HOME, 'orphan-child.pid');
  const child = spawn('/bin/bash', ['-c', 'sleep 30 & echo $! > "$1"; sleep 0.1; exit 0', 'bash', childPidFile], {
    detached: true, stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const leaderPid = child.pid!;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  registerRun(leaderPid, '/bin/bash', 'test-agent');
  try {
    for (let i = 0; i < 100 && !existsSync(childPidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(childPidFile), 'the child started');
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
    await exited;

    assert.equal(await killOrphanRuns(), 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    let state = '';
    try { state = readFileSync(`/proc/${childPid}/stat`, 'utf8').split(') ')[1]?.[0] ?? ''; } catch { /* exited */ }
    assert.ok(!state || state === 'Z', 'the surviving process-group child was stopped');
  } finally {
    try { process.kill(-leaderPid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
