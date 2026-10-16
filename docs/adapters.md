# Agentix Adapters

Every adapter runs one **turn** per `send()`: it spawns the CLI in the agent's `cwd` (with `$PWD` set
to match), reads stdout line by line, turns each JSON line into `output` / `tool` / `status` / `error`
events, and saves the CLI's own session id so the next turn (a steer) resumes the same conversation.
Shared process handling is in `packages/server/src/adapters/proc.ts`:

- the CLI runs in its own process group; **interrupt** = SIGINT to the group, then SIGTERM after 3 s
  (`AGENTIX_KILL_GRACE_MS`), so tools the CLI started die too
- a non-zero exit becomes an `error` event with the last lines of stderr, and status `error`
- `detect()` runs `<cli> --version`

The session manager owns `thinking → working → idle | stopped | error`; adapters only report activity.

## mock (tests only)
- Hidden unless `AGENTIX_MOCK=1`; the test helpers set it. With it off, the server drops any leftover
  mock agents and their events at startup.
- No external dependencies. 8 steps over ~5 s (`AGENTIX_MOCK_STEP_MS` = base ms per step).
- Stops immediately when its turn is aborted.

## codex — verified live with codex-cli 0.162.1 (2026-10-16)
- New: `codex exec --json --skip-git-repo-check -s workspace-write -C <cwd> -- <prompt>`
- Resume: `codex exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" -- <thread_id> <prompt>`
  (`resume` has no `-s`/`-C`; the sandbox goes through `-c`, the cwd is the process cwd)
- Sandbox: `AGENTIX_CODEX_SANDBOX` (default `workspace-write`)
- Events: `thread.started{thread_id}` → session id; `item.completed agent_message` → output;
  `item.started command_execution` → tool `$ cmd`; `item.completed file_change` → tool `files: add x`;
  `reasoning` → thinking activity; `turn.failed` / `error` → error
- Live check: spawn in `/tmp/agentix-test` created `hello.txt`; a steer resumed the same thread
  (appended a line to the file it remembered); steering during `sleep 60` stopped it in ~1 s and
  the next turn resumed the thread.

## opencode — verified live with opencode v2.0.30 (2026-10-16)
- `opencode run --standalone --format json --auto [-s <sessionID>] <message>` (`--` only if the
  message starts with `-`)
- `--standalone` is required: without it `run` attaches to opencode's shared background service,
  which works in that service's directory and ignores ours (seen live: files landed in the wrong
  folder). It also needs `$PWD` set to the cwd, which `proc.ts` does for every adapter.
- `--auto` approves permissions that aren't explicitly denied; nobody is there to answer prompts.
- Events carry `sessionID` → session id; `text` → output; `tool_use{part.tool, part.state.input}` →
  tool (emitted once the tool has finished); `error` → error.
- Slow: 30–60 s per turn on this machine, even for one word.
- Live check: wrote `d.txt` in the agent's cwd, and the steer (`-s`) remembered the file name.

## claude — fake-CLI tests only (kenz loses access 2026-10-17)
- `claude -p --output-format stream-json --verbose --permission-mode acceptEdits [--resume <id>] -- <prompt>`
- Events: any line's `session_id` → session id; `assistant` content `text` → output, `tool_use` → tool;
  `result` with `is_error` → error.

## pi — flags and JSON checked against @mariozechner/pi-coding-agent 0.73.1 (2026-10-16)
- `pi -p --mode json [--session <id>] [--append-system-prompt <role instructions>] <prompt>`
  (install: `npm i -g @mariozechner/pi-coding-agent`). A prompt starting with `-` or `@` gets a leading
  space, since pi would read it as a flag or a file to attach.
- Events (`docs/json.md` in the package, and a real run): first line `{type:'session',id}` → session id;
  `tool_execution_start{toolName,args}` → tool; assistant `message_end` text → output;
  `stopReason:'error'` + `errorMessage` → the turn fails (pi itself exits 0).
- `--session <id>` resumed the same session id in a real run. Role instructions go through
  `--append-system-prompt` instead of the prompt.
- Not run against a real model here (no API key); kenz should try one turn.
- `pi --version` prints to stderr; `detectCli` reads both.

## hermes — flags checked against hermes-agent 0.19.0 (2026-10-16)
- `hermes chat -Q --query=<prompt> --source tool --yolo [--resume <session_id>]`
  (install: `pip install hermes-agent`). `--query=` keeps a prompt starting with `-` from parsing as a flag.
- `-Q` prints only the final answer on stdout and `session_id: <id>` on stderr (read from the source,
  `cli.py`). There's no streaming JSON in `chat`, so no live tool events; the answer arrives at the end.
  `hermes-acp` (Agent Client Protocol over stdio) would give live events; a later upgrade.
- `--yolo` because nobody can answer approval prompts; `--source tool` keeps these runs out of kenz's
  own Hermes session list. Startup notices starting with "⚠" are dropped from the output.
- Not run against a real model here (no API key); kenz should try one turn.

## CLI paths

Settings → Agent CLIs (or `PUT /api/settings {cliPaths:{pi:"/path/to/pi"}}`, or `AGENTIX_PI_BIN`) sets the
binary for any adapter; `detect` and every turn use it.

## Adding a new adapter

1. Create `packages/server/src/adapters/<name>.ts` implementing `AgentAdapter`
   (`kind`, `detect()`, `send(ctx, prompt)`); use `runCli`/`detectCli` from `proc.ts`, honour `ctx.signal`,
   call `ctx.setNativeSessionId()` when the CLI reports its session.
2. Register it in `packages/server/src/adapters/index.ts` and add it to `AgentKind` in `packages/shared/src/types.ts`.
3. Add a fake CLI in `packages/server/test/helpers.ts` (copy real output lines) and a test in `adapters.test.ts`.
4. Run `<cli> --help` first and record the version and flags here.
