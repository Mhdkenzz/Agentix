// Real adapters driven through the session manager, against fake CLIs on PATH.
import { WORK, TMP, fakeCalls, fakeCwds, waitFor } from './helpers.ts';
import test from 'node:test';
import { realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { getAllAdapters } from '../src/adapters/index.ts';
import type { AgentEvent } from '../../shared/src/types.ts';

const sm = new SessionManager(new EventBus());
const settled = (id: string) => waitFor(() => !sm.isRunning(id) && sm.getAgent(id)!.status !== 'thinking', 8000, `${id} to finish`);
const events = (id: string, type?: string) => sm.getAgentEvents(id).filter(e => !type || e.type === type);
const texts = (es: AgentEvent[]) => es.map(e => e.text);
const usages = (id: string) => events(id, 'usage').map(e => e.data);

test('detect() reports installed CLIs with their --version', async () => {
  const found = Object.fromEntries(await Promise.all(getAllAdapters().map(async a => [a.kind, await a.detect()])));
  assert.deepEqual(found.codex, { installed: true, version: 'codex 9.9.9-fake' });
  assert.deepEqual(found.opencode, { installed: true, version: 'opencode 9.9.9-fake' });
  for (const k of ['gemini', 'aider', 'goose']) assert.deepEqual(found[k], { installed: true, version: `${k} 9.9.9-fake` });
  assert.equal(found.mock.installed, true);
});

test('codex: streams output and tools, saves thread id, steer resumes it', async () => {
  const a = sm.createAgent('codex', { cwd: WORK, prompt: 'create hello.txt' });
  await settled(a.id);

  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, 'th-fake-1');
  assert.deepEqual(texts(events(a.id, 'output')), ['Done.']);
  assert.deepEqual(texts(events(a.id, 'tool')), ['$ bash -lc ls', 'files: add /w/hello.txt']);
  assert.deepEqual(fakeCalls('codex')[0], ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', WORK, '--', 'create hello.txt']);
  assert.equal(fakeCwds('codex')[0], `${realpathSync(WORK)} ${WORK}`, 'cwd and $PWD are the agent cwd');
  assert.deepEqual(usages(a.id), [{ input: 12840, output: 356, cacheRead: 11008 }], 'turn.completed usage, once');

  await sm.steerAgent(a.id, 'now add a test');
  await settled(a.id);
  assert.deepEqual(fakeCalls('codex')[1], ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '--', 'th-fake-1', 'now add a test']);
  assert.equal(fakeCwds('codex')[1], `${realpathSync(WORK)} ${WORK}`);
  assert.equal(events(a.id, 'output').length, 2);
  assert.equal(usages(a.id).length, 2, 'one usage event per turn');
});

test('opencode: streams, saves sessionID, steer passes -s', async () => {
  const a = sm.createAgent('opencode', { cwd: WORK, prompt: 'say ok' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, 'ses_fake1');
  assert.deepEqual(texts(events(a.id, 'output')), ['ok']);
  assert.deepEqual(texts(events(a.id, 'tool')), ['shell: echo hi > x.txt']);
  assert.deepEqual(fakeCalls('opencode')[0], ['run', '--standalone', '--format', 'json', '--auto', 'say ok']);
  // two steps summed into one event; reasoning tokens count as output
  assert.deepEqual(usages(a.id), [{ input: 10546, output: 139, cacheRead: 10240, cost: 0.0153 }]);

  await sm.steerAgent(a.id, '-v looks like a flag');
  await settled(a.id);
  assert.deepEqual(fakeCalls('opencode')[1], ['run', '--standalone', '--format', 'json', '--auto', '-s', 'ses_fake1', '--', '-v looks like a flag']);
});

test('claude: streams, saves session_id, steer passes --resume', async () => {
  const a = sm.createAgent('claude', { cwd: WORK, prompt: 'hi' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, 'cl-fake-1');
  assert.deepEqual(texts(events(a.id, 'output')), ['All done']);
  assert.deepEqual(texts(events(a.id, 'tool')), ['Bash: ls']);
  assert.deepEqual(texts(events(a.id, 'thinking')), ['Check the folder first.']);
  assert.deepEqual(usages(a.id), [{ input: 9, output: 212, cacheRead: 13360, cacheWrite: 1520, cost: 0.0421 }]);
  await sm.steerAgent(a.id, 'again');
  await settled(a.id);
  assert.ok(fakeCalls('claude')[1].join(' ').includes('--resume cl-fake-1 -- again'));
});

test('claude: not signed in gives one clear error, not the CLI reply and exit code', async () => {
  process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
  try {
    const a = sm.createAgent('claude', { cwd: WORK, prompt: 'hi' });
    await settled(a.id);
    assert.equal(sm.getAgent(a.id)!.status, 'error');
    assert.deepEqual(events(a.id, 'output'), []);
    const errs = texts(events(a.id, 'error'));
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /isn't signed in.*\/login/);
  } finally {
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
  }
});

test('pi: json events, session id, --session on steer, instructions as system prompt', async () => {
  const a = sm.createAgent('pi', { cwd: WORK, prompt: 'say hi' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, '01a14434-77aa-7136-b481-570dba7b7def');
  assert.deepEqual(texts(events(a.id, 'output')), ['hi from pi']);
  assert.deepEqual(texts(events(a.id, 'tool')), ['bash: ls -la']);
  assert.deepEqual(fakeCalls('pi')[0], ['-p', '--mode', 'json', 'say hi']);
  // both assistant messages (the tool call and the answer) summed into one event
  assert.deepEqual(usages(a.id), [{ input: 2225, output: 60, cacheRead: 2112, cost: 0.0082 }]);
  await sm.steerAgent(a.id, '@file looks like an attachment');
  await settled(a.id);
  assert.deepEqual(fakeCalls('pi')[1], ['-p', '--mode', 'json', '--session', '01a14434-77aa-7136-b481-570dba7b7def', ' @file looks like an attachment']);

  const c = sm.createAgent('pi', { cwd: WORK, role: 'coordinator', prompt: 'lead', replace: true });
  try {
    await settled(c.id);
    // (fakeCalls splits on newlines, which the instructions contain, so read the raw log)
    const raw = readFileSync(join(TMP, 'pi.args'), 'utf8');
    assert.match(raw, /--append-system-prompt\0\[AGENTIX\] You are the COORDINATOR[^\0]*\0lead\0\n$/, 'instructions go in the system prompt, the prompt stays as is');
  } finally {
    sm.updateAgent(c.id, { role: 'worker' }); // a leftover coordinator would get update turns in later tests
  }
});

test('pi: a failed model call (exit 0) ends the turn in error', async () => {
  process.env.FAKE_PI_ERROR = '1';
  try {
    const a = sm.createAgent('pi', { cwd: WORK, prompt: 'x' });
    await settled(a.id);
    assert.equal(sm.getAgent(a.id)!.status, 'error');
    assert.match(texts(events(a.id, 'error')).join(), /bad token/);
  } finally { delete process.env.FAKE_PI_ERROR; }
});

test('hermes: final answer as output, session id from stderr, --resume on steer', async () => {
  const a = sm.createAgent('hermes', { cwd: WORK, prompt: '-starts with a dash' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, '20261016_101543_8b1686');
  assert.deepEqual(texts(events(a.id, 'output')), ['Hello from Hermes.\nSecond line.']);
  assert.deepEqual(fakeCalls('hermes')[0], ['chat', '-Q', '--query=-starts with a dash', '--source', 'tool', '--yolo']);
  await sm.steerAgent(a.id, 'more');
  await settled(a.id);
  assert.deepEqual(fakeCalls('hermes')[1], ['chat', '-Q', '--query=more', '--source', 'tool', '--yolo', '--resume', '20261016_101543_8b1686']);
  assert.deepEqual(usages(a.id), [], 'hermes reports no tokens');
});

test('gemini: stream-json deltas joined per message, tools, session id, usage, --resume on steer', async () => {
  const a = sm.createAgent('gemini', { cwd: WORK, prompt: 'say hi' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, '8f3b2c1e-5d4a-4f6b-9c7e-1a2b3c4d5e6f');
  assert.deepEqual(texts(events(a.id, 'output')), ["I'll look at the files first.", 'Hello from Gemini.']);
  assert.deepEqual(texts(events(a.id, 'tool')), ['run_shell_command: ls -la']);
  assert.deepEqual(usages(a.id), [{ input: 8432, output: 218, cacheRead: 4096 }]);
  assert.deepEqual(fakeCalls('gemini')[0], ['-p', 'say hi', '--output-format', 'stream-json', '--approval-mode', 'auto_edit']);

  await sm.steerAgent(a.id, '-v looks like a flag');
  await settled(a.id);
  assert.deepEqual(fakeCalls('gemini')[1], ['-p', ' -v looks like a flag', '--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--resume', '8f3b2c1e-5d4a-4f6b-9c7e-1a2b3c4d5e6f']);
  assert.equal(usages(a.id).length, 2);
});

test('gemini: an error result fails the turn with its message, not the exit code', async () => {
  process.env.FAKE_GEMINI_ERROR = '1';
  try {
    const a = sm.createAgent('gemini', { cwd: WORK, prompt: 'x' });
    await settled(a.id);
    assert.equal(sm.getAgent(a.id)!.status, 'error');
    assert.deepEqual(texts(events(a.id, 'error')), ['Please set an Auth method in your settings.json']);
    assert.deepEqual(usages(a.id), [], 'all-zero stats give no usage event');
  } finally { delete process.env.FAKE_GEMINI_ERROR; }
});

test('aider: plain-text reply as one output, edits and commits as tools, usage, history restored on steer', async () => {
  const a = sm.createAgent('aider', { cwd: WORK, prompt: 'create hello.py' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, `aider:${WORK}`);
  assert.deepEqual(texts(events(a.id, 'output')), ["I'll create hello.py with a greeting.\n\nDone: hello.py prints hello."]);
  assert.deepEqual(texts(events(a.id, 'tool')), ['edit: hello.py', 'git commit 1a2b3c4: feat: Add hello.py with a greeting']);
  assert.deepEqual(usages(a.id), [{ input: 2300, output: 120, cacheRead: 4500, cacheWrite: 1100, cost: 0.0123 }]);
  const flags = ['--yes-always', '--no-pretty', '--no-stream', '--no-fancy-input', '--no-check-update', '--no-show-model-warnings', '--no-analytics'];
  assert.deepEqual(fakeCalls('aider')[0], ['--message', 'create hello.py', ...flags]);
  assert.equal(fakeCwds('aider')[0], `${realpathSync(WORK)} ${WORK}`, 'runs in the agent cwd, where its chat history lives');

  await sm.steerAgent(a.id, '--also add a test');
  await settled(a.id);
  assert.deepEqual(fakeCalls('aider')[1], ['--message=--also add a test', ...flags, '--restore-chat-history']);
});

test('goose: named session, plain-text reply, tool calls, --resume on steer', async () => {
  const a = sm.createAgent('goose', { cwd: WORK, prompt: 'look around' });
  await settled(a.id);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  const name = sm.getAgent(a.id)!.nativeSessionId!;
  assert.match(name, new RegExp(`^agentix-${a.id}-[0-9a-z]+$`));
  assert.deepEqual(fakeCalls('goose')[0], ['run', '--name', name, '--text', 'look around']);
  assert.deepEqual(texts(events(a.id, 'output')), ["I'll check the folder.\n\nThe folder has hello.txt."]);
  assert.deepEqual(texts(events(a.id, 'tool')), ['shell: ls -la']);

  await sm.steerAgent(a.id, '-more');
  await settled(a.id);
  assert.deepEqual(fakeCalls('goose')[1], ['run', '--name', name, '--resume', '--text=-more']);
  assert.equal(sm.getAgent(a.id)!.nativeSessionId, name);

  await sm.newSession(a.id);
  await sm.steerAgent(a.id, 'fresh start');
  await settled(a.id);
  const third = fakeCalls('goose')[2];
  assert.ok(!third.includes('--resume') && third[2] !== name, 'a new session gets a new name');
});

test('status goes thinking -> working -> idle with no duplicate status events', async () => {
  const a = sm.createAgent('codex', { cwd: WORK, prompt: 'x' });
  await settled(a.id);
  const statuses = events(a.id, 'status').map(e => (e.data as any).status);
  assert.equal(statuses[0], 'thinking');
  assert.ok(statuses.includes('working'));
  assert.equal(statuses.at(-1), 'idle');
  const pairs = events(a.id, 'status').map(e => JSON.stringify(e.data));
  for (let i = 1; i < pairs.length; i++) assert.notEqual(pairs[i], pairs[i - 1], 'consecutive duplicate status');
});

test('a failing CLI ends in error status with its stderr', async () => {
  process.env.FAKE_FAIL = '1';
  try {
    const a = sm.createAgent('codex', { cwd: WORK, prompt: 'x' });
    await settled(a.id);
    assert.equal(sm.getAgent(a.id)!.status, 'error');
    assert.match(texts(events(a.id, 'error')).join('\n'), /exited with 3: boom: model unavailable/);
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('interrupt kills a hanging CLI with SIGINT', async () => {
  process.env.FAKE_HANG = '1';
  try {
    const before = fakeCalls('codex').length;
    const a = sm.createAgent('codex', { cwd: WORK, prompt: 'hang' });
    await waitFor(() => fakeCalls('codex').length > before, 5000, 'codex to start');
    const t0 = Date.now();
    await sm.interruptAgent(a.id);
    assert.ok(Date.now() - t0 < 1500, 'SIGINT should be enough');
    assert.equal(sm.getAgent(a.id)!.status, 'stopped');
    assert.equal(sm.isRunning(a.id), false);
  } finally {
    delete process.env.FAKE_HANG;
  }
});

test('interrupt falls back to SIGTERM when SIGINT is ignored, and kills child processes', async () => {
  process.env.FAKE_HANG = '1';
  process.env.FAKE_IGNORE_INT = '1';
  try {
    const before = fakeCalls('codex').length;
    const a = sm.createAgent('codex', { cwd: WORK, prompt: 'stubborn' });
    await waitFor(() => fakeCalls('codex').length > before, 5000, 'codex to start');
    await new Promise(r => setTimeout(r, 100)); // let it reach `sleep`
    const { execFileSync } = await import('node:child_process');
    const sleeps = () => execFileSync('pgrep', ['-f', '^sleep 30$'], { encoding: 'utf-8' }).trim().split('\n').filter(Boolean).map(Number);
    const pids = sleeps();
    assert.ok(pids.length > 0);
    await sm.interruptAgent(a.id);
    assert.equal(sm.getAgent(a.id)!.status, 'stopped');
    await waitFor(() => pids.every(p => !alive(p)), 3000, 'grandchild sleep to die');
  } finally {
    delete process.env.FAKE_HANG;
    delete process.env.FAKE_IGNORE_INT;
  }
});

test('steering a busy CLI agent kills the old turn before resuming', async () => {
  process.env.FAKE_HANG = '1';
  const a = sm.createAgent('codex', { cwd: WORK, prompt: 'long task' });
  const before = fakeCalls('codex').length;
  await waitFor(() => sm.getAgent(a.id)!.nativeSessionId, 5000, 'session id');
  delete process.env.FAKE_HANG;
  await sm.steerAgent(a.id, 'change of plan');
  await settled(a.id);
  const calls = fakeCalls('codex').slice(before - 1);
  assert.deepEqual(calls.at(-1)!.slice(-2), ['th-fake-1', 'change of plan']);
  assert.equal(sm.getAgent(a.id)!.status, 'idle');
  const types = events(a.id).map(e => e.type === 'status' ? (e.data as any).status : e.type);
  const steerAt = types.indexOf('steer');
  assert.deepEqual(types.slice(steerAt, steerAt + 3), ['steer', 'stopped', 'thinking']);
});
