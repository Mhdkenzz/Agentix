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

## mock
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

## Adding a new adapter

1. Create `packages/server/src/adapters/<name>.ts` implementing `AgentAdapter`
   (`kind`, `detect()`, `send(ctx, prompt)`); use `runCli`/`detectCli` from `proc.ts`, honour `ctx.signal`,
   call `ctx.setNativeSessionId()` when the CLI reports its session.
2. Register it in `packages/server/src/adapters/index.ts` and add it to `AgentKind` in `packages/shared/src/types.ts`.
3. Add a fake CLI in `packages/server/test/helpers.ts` (copy real output lines) and a test in `adapters.test.ts`.
4. Run `<cli> --help` first and record the version and flags here.
