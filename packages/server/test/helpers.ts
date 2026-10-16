// Test setup: import this FIRST in every test file, before anything from src/.
// It points the store at a throwaway directory (never the real ~/.agentix),
// speeds up timers, and puts fake agent CLIs (codex, opencode, claude, pi, hermes, gemini, aider, goose) first on PATH.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TMP = mkdtempSync(join(tmpdir(), 'agentix-test-'));
export const BIN = join(TMP, 'bin');
export const WORK = join(TMP, 'work');
mkdirSync(BIN);
mkdirSync(WORK);

process.env.AGENTIX_HOME = join(TMP, 'home');
process.env.AGENTIX_MOCK = '1';
process.env.AGENTIX_MOCK_STEP_MS = '20';
process.env.AGENTIX_UPDATE_DELAY_MS = '100';
process.env.AGENTIX_CEO_REPLY_TIMEOUT_MS = '1000';
process.env.AGENTIX_KILL_GRACE_MS = '300';
process.env.PATH = `${BIN}:${process.env.PATH}`;
// Prompts reach the fakes unchanged unless a test turns the [SHARED CONTEXT] block back on.
mkdirSync(process.env.AGENTIX_HOME, { recursive: true });
writeFileSync(join(process.env.AGENTIX_HOME, 'settings.json'), JSON.stringify({ sharedContext: false }));

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
if [ "$1" = "--help" ]; then echo "usage: ${name} [options] -p --mode json --append-system-prompt <text>"; exit 0; fi
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
  '{"type":"turn.completed","usage":{"input_tokens":12840,"cached_input_tokens":11008,"output_tokens":356}}',
]);
fake('opencode', [
  '{"type":"step_start","sessionID":"ses_fake1","part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_fake1","part":{"type":"tool","tool":"shell","state":{"status":"completed","input":{"command":"echo hi > x.txt"},"output":"(no output)"}}}',
  '{"type":"step_finish","sessionID":"ses_fake1","part":{"type":"step-finish","reason":"tool-calls","cost":0.0132,"tokens":{"input":10234,"output":87,"reasoning":12,"cache":{"read":0,"write":0}}}}',
  '{"type":"step_start","sessionID":"ses_fake1","part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_fake1","part":{"type":"text","text":"ok"}}',
  '{"type":"step_finish","sessionID":"ses_fake1","part":{"type":"step-finish","reason":"stop","cost":0.0021,"tokens":{"input":312,"output":40,"reasoning":0,"cache":{"read":10240,"write":0}}}}',
]);
fake('claude', [
  '{"type":"system","subtype":"init","session_id":"cl-fake-1"}',
  '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Check the folder first."}]},"session_id":"cl-fake-1"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]},"session_id":"cl-fake-1"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"All done"}]},"session_id":"cl-fake-1"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"All done","session_id":"cl-fake-1","num_turns":2,"total_cost_usd":0.0421,"usage":{"input_tokens":9,"cache_creation_input_tokens":1520,"cache_read_input_tokens":13360,"output_tokens":212}}',
]);

// FAKE_CLAUDE_LOGGED_OUT=1: what Claude Code prints with no credentials (a synthetic reply, an error result, exit 1).
{
  const p = join(BIN, 'claude');
  writeFileSync(p, readFileSync(p, 'utf8').replace('[ -n "$FAKE_IGNORE_INT" ]', `if [ -n "$FAKE_CLAUDE_LOGGED_OUT" ]; then
  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"cl-out-1"}'
  printf '%s\\n' '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"session_id":"cl-out-1"}'
  printf '%s\\n' '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"cl-out-1"}'
  exit 1
fi
[ -n "$FAKE_IGNORE_INT" ]`));
}

// Trimmed from real `pi -p --mode json` output (0.73.1). FAKE_PI_ERROR=1 ends with a failed model call (exit 0, like pi).
fake('pi', [
  '{"type":"session","version":3,"id":"01a14434-77aa-7136-b481-570dba7b7def","timestamp":"2026-10-16T10:14:11.627Z","cwd":"/w"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"say hi"}]}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"t1","name":"bash","arguments":{"command":"ls -la"}}],"stopReason":"toolUse","usage":{"input":2130,"output":48,"cacheRead":0,"cacheWrite":0,"totalTokens":2178,"cost":{"input":0.0064,"output":0.0007,"cacheRead":0,"cacheWrite":0,"total":0.0071}}}}',
  '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls -la"}}',
  '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{},"isError":false}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi from pi"}],"stopReason":"stop","usage":{"input":95,"output":12,"cacheRead":2112,"cacheWrite":0,"totalTokens":2219,"cost":{"input":0.0003,"output":0.0002,"cacheRead":0.0006,"cacheWrite":0,"total":0.0011}}}}',
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

// Gemini CLI `-p --output-format stream-json`, written from its StreamJsonFormatter calls (0.64.0), not a real run.
// FAKE_GEMINI_ERROR=1 gives an error result and exit 41, as when no auth method is set.
fake('gemini', [
  '{"type":"init","timestamp":"2026-10-16T10:20:01.112Z","session_id":"8f3b2c1e-5d4a-4f6b-9c7e-1a2b3c4d5e6f","model":"gemini-2.5-pro"}',
  '{"type":"message","timestamp":"2026-10-16T10:20:01.115Z","role":"user","content":"say hi"}',
  '{"type":"message","timestamp":"2026-10-16T10:20:03.201Z","role":"assistant","content":"I\'ll look","delta":true}',
  '{"type":"message","timestamp":"2026-10-16T10:20:03.260Z","role":"assistant","content":" at the files first.","delta":true}',
  '{"type":"tool_use","timestamp":"2026-10-16T10:20:03.410Z","tool_name":"run_shell_command","tool_id":"run_shell_command-1760610003410-1","parameters":{"command":"ls -la","description":"List files"}}',
  '{"type":"tool_result","timestamp":"2026-10-16T10:20:03.502Z","tool_id":"run_shell_command-1760610003410-1","status":"success","output":"hello.txt"}',
  '{"type":"message","timestamp":"2026-10-16T10:20:05.010Z","role":"assistant","content":"Hello","delta":true}',
  '{"type":"message","timestamp":"2026-10-16T10:20:05.044Z","role":"assistant","content":" from Gemini.","delta":true}',
  '{"type":"result","timestamp":"2026-10-16T10:20:05.120Z","status":"success","stats":{"total_tokens":8650,"input_tokens":8432,"output_tokens":218,"cached":4096,"input":4336,"duration_ms":4008,"tool_calls":1}}',
]);
{
  const p = join(BIN, 'gemini');
  writeFileSync(p, readFileSync(p, 'utf8').replace('[ -n "$FAKE_IGNORE_INT" ]', `if [ -n "$FAKE_GEMINI_ERROR" ]; then
  printf '%s\\n' '{"type":"init","session_id":"9a8b7c6d-0000-4000-8000-000000000001","model":"gemini-2.5-pro"}'
  printf '%s\\n' '{"type":"result","status":"error","error":{"type":"FatalAuthenticationError","message":"Please set an Auth method in your settings.json"},"stats":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"cached":0,"input":0,"duration_ms":0,"tool_calls":0}}'
  echo "Please set an Auth method" >&2
  exit 41
fi
[ -n "$FAKE_IGNORE_INT" ]`));
}

// Aider with --no-pretty --no-stream: banner, the reply, the token report, then what it applied (strings from 0.86.2).
fake('aider', [
  'Aider v0.86.2',
  'Main model: anthropic/claude-sonnet-4-20250514 with diff edit format, infinite output',
  'Weak model: anthropic/claude-3-5-haiku-20241022',
  'Git repo: .git with 3 files',
  'Repo-map: using 4096 tokens, auto refresh',
  'Restored previous conversation history.',
  '',
  'I\'ll create hello.py with a greeting.',
  '',
  'Done: hello.py prints hello.',
  '',
  'Tokens: 2.3k sent, 1.1k cache write, 4.5k cache hit, 120 received.',
  'Cost: $0.0123 message, $0.0456 session.',
  'Applied edit to hello.py',
  'Commit 1a2b3c4 feat: Add hello.py with a greeting',
]);

// Goose `run` (from its docs, not a real run): a session banner, the reply, and a tool call as a header plus parameters.
fake('goose', [
  'starting session | provider: anthropic model: claude-sonnet-4-5',
  '    session id: 20261016_1',
  '    working directory: /w',
  '',
  'I\'ll check the folder.',
  '─── shell | developer ──────────────────────────',
  'command: ls -la',
  '',
  '',
  'The folder has hello.txt.',
]);

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
