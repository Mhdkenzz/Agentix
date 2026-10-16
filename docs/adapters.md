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

## Usage events

Adapters whose CLI reports token use emit one `usage` event per turn, `data` being a `Usage`
(`packages/shared/src/types.ts`): `{ input, output, cacheRead?, cacheWrite?, cost? }`, cost in USD.
`UsageTally` / `emitUsage` in `proc.ts` do the bookkeeping: missing or non-numeric fields count as 0,
optional fields appear only when non-zero, and a turn with nothing to report emits no event. CLIs that
report per step are summed and emitted once when the turn ends (also when it fails).

| adapter  | source                                                         | input / output                         | cacheRead / cacheWrite                                  | cost              |
|----------|----------------------------------------------------------------|----------------------------------------|---------------------------------------------------------|-------------------|
| codex    | `turn.completed.usage`                                         | `input_tokens` / `output_tokens`       | `cached_input_tokens` / –                               | –                 |
| claude   | final `result` event                                           | `usage.input_tokens` / `output_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` | `total_cost_usd` |
| opencode | every `step_finish` `part.tokens`, summed                      | `input` / `output + reasoning`         | `cache.read` / `cache.write`                            | `part.cost`       |
| pi       | every assistant `message_end` `message.usage`, summed          | `input` / `output`                     | `cacheRead` / `cacheWrite`                              | `cost.total`      |
| gemini   | `result.stats` (whole-run totals)                              | `input_tokens` / `output_tokens`       | `cached` / –                                            | –                 |
| aider    | "Tokens: … sent, … cache write, … cache hit, … received." + "Cost: $x message", summed | sent / received | cache hit / cache write                       | message cost      |
| hermes, goose | nothing reported                                          |                                        |                                                         |                   |

`input` follows each CLI's own meaning: codex and gemini count cached tokens inside `input`, claude and pi
don't. Aider's counts are rounded (`2.3k`), so they're approximate.

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

## gemini — NOT run against a real CLI; flags and events read from @google/gemini-cli 0.64.0 (2026-10-16)
- `gemini -p <prompt> --output-format stream-json --approval-mode auto_edit [--resume <session_id>]`
  (install: `npm i -g @google/gemini-cli`). A prompt starting with `-` gets a leading space.
- `--resume` takes the full session UUID (or `latest` / an index); sessions are stored per project
  directory, which is the agent's cwd. The id comes from the `init` line.
- `auto_edit` approves file edits only; tools that need approval (shell) are refused in headless mode and
  the model sees the refusal. `AGENTIX_GEMINI_APPROVAL=yolo` approves everything.
- Events: `message` with `role:'assistant'` arrives as `delta:true` chunks, joined into one output per
  message (a tool call or the result ends a message); `tool_use{tool_name,parameters}` → tool;
  `tool_result` with `status:'error'` → tool "… failed"; `error{severity,message}` → error;
  `result{status,error?,stats}` → usage, and `status:'error'` fails the turn with `error.message`.
- No system-prompt flag (`GEMINI_SYSTEM_MD` replaces the whole system prompt), so role instructions go in
  front of the prompt. Field reads fall back to likely alternative names in case they change.

## aider — flags checked against aider-chat 0.86.2 (`aider/args.py`); not run against a real model
- `aider --message <prompt> --yes-always --no-pretty --no-stream --no-fancy-input --no-check-update
  --no-show-model-warnings --no-analytics [--restore-chat-history]` in the agent's cwd
  (install: `pip install aider-chat`). A prompt starting with `-` is passed as `--message=<prompt>`.
- No session ids: aider keeps the conversation in `.aider.chat.history.md` in the cwd. After the first
  turn the session id is `aider:<cwd>`, and later turns add `--restore-chat-history`. A new session runs
  without it (no memory); the history file is never deleted, so a resume restores everything in it,
  including turns of other aider runs in the same folder.
- `--no-analytics`: with `--yes-always` aider would otherwise accept its analytics opt-in question.
  `--yes-always` also means aider creates a git repo in a folder that has none, and commits its edits.
- Plain-text output, emitted as one `output` at the end (blank lines kept, startup banner dropped).
  `Applied edit to <file>` → tool `edit: <file>`; `Commit <hash> <msg>` → tool; the
  `Tokens:` / `Cost:` report → usage.
- No system-prompt flag, so role instructions go in front of the prompt.

## goose — NOT run against a real CLI; written from Block's goose documentation
- `goose run --name <name> [--resume] --text <prompt>` (a prompt starting with `-` is passed as
  `--text=<prompt>`). The session is kept (no `--no-session`).
- Agentix names the session `agentix-<agentId>-<time>` and saves the name as the session id after the first
  successful turn; later turns add `--resume`. "New session" picks a new name, so it starts over.
- Plain-text output, emitted as one `output` at the end. Tool calls printed as
  `─── shell | developer ───` plus `command: …` lines become tool events; the session banner
  (`starting session | …`, `session id:`, `working directory:`, `logging to …`) is dropped.
- No token report; no system-prompt flag in `goose run`, so role instructions go in front of the prompt.

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
