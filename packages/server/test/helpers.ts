// Test setup: import this FIRST in every test file, before anything from src/.
// It points the store at a throwaway directory (never the real ~/.agentix),
// speeds up timers, and puts fake codex/opencode/claude CLIs first on PATH.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TMP = mkdtempSync(join(tmpdir(), 'agentix-test-'));
export const BIN = join(TMP, 'bin');
export const WORK = join(TMP, 'work');
mkdirSync(BIN);
mkdirSync(WORK);

process.env.AGENTIX_HOME = join(TMP, 'home');
process.env.AGENTIX_MOCK_STEP_MS = '20';
process.env.AGENTIX_UPDATE_DELAY_MS = '100';
process.env.AGENTIX_KILL_GRACE_MS = '300';
process.env.PATH = `${BIN}:${process.env.PATH}`;

// A tiny fake dashboard build for the static-file tests.
export const WEB = join(TMP, 'web') + '/';
mkdirSync(join(WEB, 'assets'), { recursive: true });
writeFileSync(join(WEB, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(join(WEB, 'assets', 'app-123.js'), 'console.log(1)');
writeFileSync(join(TMP, 'secret.txt'), 'nope');
process.env.AGENTIX_WEB_DIST = WEB;

// Each fake logs its argv (one line, NUL-separated) and cwd, then prints canned JSONL.
// FAKE_HANG=1 makes it hang after the first line; FAKE_IGNORE_INT=1 makes it ignore SIGINT.
function fake(name: string, lines: string[]) {
  const body = lines.map(l => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'`).join('\n');
  writeFileSync(join(BIN, name), `#!/bin/bash
if [ "$1" = "--version" ]; then echo "${name} 9.9.9-fake"; exit 0; fi
[ -n "$FAKE_IGNORE_INT" ] && trap '' INT
{ printf '%s\\0' "$@"; printf '\\n'; } >> "${join(TMP, name + '.args')}"
echo "$(pwd -P) $PWD" >> "${join(TMP, name + '.cwd')}"
${body.split('\n')[0]}
if [ -n "$FAKE_HANG" ]; then sleep 30; sleep 30; fi
${body.split('\n').slice(1).join('\n')}
if [ -n "$FAKE_FAIL" ]; then echo "boom: model unavailable" >&2; exit 3; fi
`);
  chmodSync(join(BIN, name), 0o755);
}

// Lines below are trimmed copies of real output (codex-cli 0.162.1, opencode 2.0.30).
fake('codex', [
  '{"type":"thread.started","thread_id":"th-fake-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/w/hello.txt","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
]);
fake('opencode', [
  '{"type":"step_start","sessionID":"ses_fake1","part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_fake1","part":{"type":"tool","tool":"shell","state":{"status":"completed","input":{"command":"echo hi > x.txt"},"output":"(no output)"}}}',
  '{"type":"text","sessionID":"ses_fake1","part":{"type":"text","text":"ok"}}',
  '{"type":"step_finish","sessionID":"ses_fake1","part":{"type":"step-finish","reason":"stop"}}',
]);
fake('claude', [
  '{"type":"system","subtype":"init","session_id":"cl-fake-1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]},"session_id":"cl-fake-1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"All done"}]},"session_id":"cl-fake-1"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"All done","session_id":"cl-fake-1"}',
]);

// Trimmed from real `pi -p --mode json` output (0.73.1). FAKE_PI_ERROR=1 ends with a failed model call (exit 0, like pi).
fake('pi', [
  '{"type":"session","version":3,"id":"01a14434-77aa-7136-b481-570dba7b7def","timestamp":"2026-10-16T10:14:11.627Z","cwd":"/w"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"say hi"}]}}',
  '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls -la"}}',
  '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{},"isError":false}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi from pi"}],"stopReason":"stop"}}',
  '{"type":"agent_end","messages":[]}',
]);
{
  const p = join(BIN, 'pi');
  writeFileSync(p, readFileSync(p, 'utf8').replace('if [ -n "$FAKE_FAIL" ]', `if [ -n "$FAKE_PI_ERROR" ]; then printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"UnrecognizedClientException: bad token"}}'; fi
if [ -n "$FAKE_FAIL" ]`));
}

// Hermes `chat -Q`: a startup notice and the final answer on stdout, "session_id: <id>" on stderr (v0.19.0).
writeFileSync(join(BIN, 'hermes'), `#!/bin/bash
if [ "$1" = "--version" ]; then echo "Hermes Agent v9.9.9-fake (2026.7.20)"; exit 0; fi
{ printf '%s\\0' "$@"; printf '\\n'; } >> "${join(TMP, 'hermes.args')}"
echo "  ⚠ tirith security scanner enabled but not available"
echo "Hello from Hermes."
echo "Second line."
printf '\\nsession_id: 20261016_101543_8b1686\\n' >&2
`);
chmodSync(join(BIN, 'hermes'), 0o755);

/** argv of each call to a fake CLI */
export function fakeCalls(name: string): string[][] {
  const p = join(TMP, name + '.args');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => l.split('\0').filter(Boolean));
}

export function fakeCwds(name: string): string[] {
  const p = join(TMP, name + '.cwd');
  return existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter(Boolean) : [];
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until `fn` returns truthy (or throw after `ms`). */
export async function waitFor<T>(fn: () => T | undefined | false, ms = 5000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
