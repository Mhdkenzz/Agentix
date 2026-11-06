# Agentix — Progress

## How to run

`node` isn't on PATH on this machine. The bundled Node 24 works:

```bash
export PATH=/usr/lib/chatgpt/resources/cua_node/bin:$PATH
node packages/cli/src/agentix.ts server          # or: AGENTIX_PORT=4399 ... server
node packages/cli/src/agentix.ts doctor
node --test packages/server/test/*.test.ts       # uses a temp AGENTIX_HOME, never ~/.agentix
```

Env vars: `AGENTIX_PORT` (default 4317), `AGENTIX_URL` (CLI), `AGENTIX_HOME` (default `~/.agentix`),
`AGENTIX_STORE=json` (force the JSON fallback), `AGENTIX_CODEX_SANDBOX`, `AGENTIX_UPDATE_DELAY_MS`, `AGENTIX_CEO_REPLY_TIMEOUT_MS`
(coordinator batching, default 5000), `AGENTIX_TOKEN` (lock the API), `AGENTIX_MAX_AGENTS`,
`AGENTIX_MAX_CONCURRENT_TURNS`, `AGENTIX_TURN_TIMEOUT_MS`, `AGENTIX_SSE_MAX_REPLAY`.

The mock agent kind is for tests only: it is hidden unless `AGENTIX_MOCK=1` (the test helpers set it).
Without it, the server removes any leftover mock agents and their history when it starts.

## Step 1: Agent backend + CLI — done (2026-10-16)

First pass by OpenCode (commit 49bb2b3); blockers fixed after review on branch `step1-fixes`.

### Acceptance checks (re-run 2026-10-16)
1. ✅ `agentix doctor`: Node v24.21.0, store sqlite, server up/down, codex-cli 0.162.1, opencode v2.0.30, claude 2.1.300
2. ✅ `agentix server` on 127.0.0.1:4317; a second server fails with a clear "port in use" message
3. ✅ `agentix spawn mock "hello"` → `ls` shows thinking → working → idle
4. ✅ `agentix watch` shows live events (was crashing: Node has no EventSource; now a fetch-based SSE reader)
5. ✅ `agentix steer <id>` mid-turn interrupts it; the old turn never finishes (it used to keep running)
6. ✅ three mock agents at once, no interference
7. ✅ restart keeps agents + history; agents that were mid-turn are reset to idle
8. ✅ `curl -N .../api/stream` shows SSE with ids and event names
9. ✅ `node --test packages/server/test/*.test.ts`: 28/28 (store, migration, adapters vs fake CLIs, sessions, HTTP/SSE, CLI)
10. ✅ Real Codex: `spawn codex --cwd /tmp/agentix-test "create hello.txt containing hi"` streamed live,
    created the file; `steer` resumed the same thread. Steering during `sleep 60` killed it in ~1 s.
    Real OpenCode also works end to end, with resume.

### What was fixed
- **Adapters** (`adapters/codex.ts`, `opencode.ts`, `claude.ts`, new `proc.ts`): use `spawn()` with
  line-by-line JSON parsing. Before, output was never read, the session id was never captured and
  steer never resumed. Flags and event shapes were checked against the real CLIs (see `docs/adapters.md`).
- **Interrupt/steer** (`sessions.ts`): each turn has an AbortController; the CLI's process group gets
  SIGINT, then SIGTERM after 3 s. Before, nothing was killed, so a steer ran two turns at once.
  Racing steers can't orphan a process either.
- **Store** (`store.ts`): `node:sqlite` `DatabaseSync` with prepared statements (before, it imported a
  non-existent `Database` and always fell back to JSON; the `from` column is now `sender`). The old
  `~/.agentix/agentix.json` is imported once on first start, then renamed `agentix.json.imported`.
  The JSON fallback batches its writes.
- **Coordinator updates**: steers of workers and finished/failed worker turns are batched (5 s) into one
  `[AGENTIX UPDATE]` message plus team digest; it's published and **run as a coordinator turn**
  (queued while the coordinator is busy). Before, it was written to the store and never sent.
- **Roles**: a second coordinator/CEO now gets 409 unless `replace` (`--replace` in the CLI) is set;
  before, the old one was demoted silently.
- **Small ones**: no duplicate status events; SSE no longer replays twice; random avatar by default;
  `AGENTIX_PORT`; multi-word prompts no longer truncated; `logs -f` streams over SSE; errors from the
  API reach the CLI; `GET /api/agents/:id`.

### Known issues / not done
- No `npm` on this machine. Internet works, so install npm (or Node with npm) before Step 2.
- OpenCode is slow here: 30–60 s per turn.
- Claude adapter is tested only against a fake CLI (access ends 2026-10-17).
- Coordinator `@@spawn` / `@@steer` command parsing and the CEO are Step 3.

## Step 2: Live 3D office dashboard — done (2026-10-16)

`packages/web`: Vite + React 19 + @react-three/fiber + drei + Zustand + react-router. Everything in the
scene is built from primitives (no model or font downloads), so it works offline.

**The built dashboard is committed** (`packages/web/dist`), so `agentix server` serves it at
http://127.0.0.1:4317/ on a machine without npm. After changing `packages/web/src`, run `npm run build`
and commit `dist` too (CI fails if it's stale).

```bash
npm install                 # once, at the repo root (needs npm)
npm run dev:web             # Vite on :5173, proxies /api to :4317 (AGENTIX_PORT/AGENTIX_URL)
npm run build               # writes packages/web/dist, served by the server at /
```

What's there:
- **Office** (`office/`): main room with cubicle desks in rows of 4 (more rows appear as workers are
  added), the coordinator's glass office, the CEO's raised gold corner, windows, plants.
- **10 avatars** (`avatars/`): Robot, Astronaut, Wizard, Ninja, Cat-person, Hacker, Scientist, Pirate,
  Knight, Alien; 3D from primitives plus SVG thumbnails for the picker.
- **Live status**: name tag, role badge and activity bubble above each agent; thinking = bobbing + "…",
  working = typing + glowing laptop, waiting_input = raised hand + "?", error = red pulse + red light.
  Agent-to-agent `message`/`steer` events fly a paper plane between desks.
- **New agent** modal: kind (only installed CLIs enabled), role, name, folder, first prompt, avatar or
  Random; a 409 for a second coordinator/CEO offers "Replace it".
- **Agent panel** (click an avatar): live log, steer box (Enter sends; interrupts a busy turn),
  Interrupt, Remove.
- Server: serves `dist` with SPA fallback (`AGENTIX_WEB_DIST` overrides the folder);
  `GET /api/agents` now returns `lastEventId` so the dashboard streams from there; auto names are unique.

### Acceptance checks (headless Chromium, mock agents)
1. ✅ Built app served by the server at `/`; `npm run dev` proxies `/api`.
2. ✅ Spawned agents sit at desks, animate and show live activity.
3. ✅ Chosen avatar is used (Pirate → 7); Random picks one.
4. ✅ Coordinator sits in the glass office, CEO on the platform.
5. ✅ Clicking an avatar opens its panel; a steer shows at once and the new turn's tool events start within ~1 s.
6. ⚠️ FPS can't be measured here (software GL only). 18 agents is ~700 draw calls, fine for a laptop GPU.
   If it's slow: lower `dpr` or turn off `shadows` in `office/OfficeScene.tsx`.

Gotcha: the first drei `<Html>` in a Canvas renders empty with drei 10.7 + React 19.3, so the scene
mounts a throwaway one first.

## Step 3: Coordinator and CEO — done (2026-10-16)

- **@@ commands** (`server/src/commands.ts`): the coordinator's output can contain
  `@@spawn kind=… name=… avatar=… cwd=… :: task`, `@@steer <id|name> :: text`, `@@stop <id|name>` and
  `@@tell ceo :: text`; the CEO can only `@@tell coordinator :: text` (anything else is an error on the CEO).
  Each command shows as a `message`/`steer` event from the sender, so the office flies a paper plane.
  Bad commands become `error` events on the sender.
- **Role instructions**: coordinator and CEO get a short brief on their first turn of a session (and again
  after a role change). CLI adapters put it in front of the prompt (`withInstructions`); mock ignores it.
- **CEO digest**: every CEO turn starts with `[TEAM STATUS]` (all agents, status, activity, last output),
  then `[FROM KENZ]` and kenz's words. Coordinator → CEO messages are queued while the CEO is busy.
- **CEO request watchdog**: a CEO request with no coordinator reply gets two queued, non-interrupting follow-ups;
  after three unanswered requests, Agentix reports the issue without interrupting the active run.
- **Coordinator modes** (`GET/PUT /api/settings`, top-bar selector, `~/.agentix/settings.json`):
  `human` (kenz coordinates; no updates, coordinator commands ignored), `agent` (the dashboard sends kenz's
  worker instructions to the coordinator via `POST /api/coordinator/ask`), `both` (default).
- **CEO page** (`/ceo`): chat with the CEO, hold Space or the mic button to talk (Web Speech API, Chrome/Edge),
  replies read aloud (toggle), text works everywhere, team sidebar. "Hire a CEO" if there isn't one.
- Mock adapter: prompt lines starting `say: ` are output verbatim, so a mock coordinator/CEO can issue
  commands (`agentix steer <coord> "say: @@spawn kind=mock :: hi"`).
- Settings also hold per-adapter CLI path overrides (`cliPaths`), used by `detect` and every run;
  `AGENTIX_<KIND>_BIN` works too.

### Acceptance checks
1. ✅ Steering a worker from the UI → coordinator's `[AGENTIX UPDATE]` turn 5.1 s later (headless Chromium).
2. ✅ Coordinator `@@spawn` puts a new worker at a desk; `@@steer` steers it; `@@stop` stops it.
3. ✅ CEO "@@tell coordinator :: start the tests" → `message` CEO→coordinator; nothing from CEO to any worker.
4. ⚠️ Voice: push-to-talk and speech output are wired to the Web Speech API but can't be tested headless.
   Try it in Chrome on `/ceo`. Recognition usually needs internet.
- 39/39 `node --test` (8 new in `coordinator.test.ts`).

## Step 4: More pages and agents — done (2026-10-16)

- **Agents** (`/agents`): table of every agent, filter by role/kind/status and search; rename inline,
  change role (409 → "make this one the coordinator instead?") and avatar; select several to stop or
  remove; Watch (opens the office panel) and History links.
- **History** (`/history`): agents by latest activity with event counts, full-text search over all events
  (`GET /api/events?q=&agent=&type=&before=&limit=`, newest first, pages backwards), type chips, and a
  Resume box that sends a new turn on the agent's own native session.
- **Settings** (`/settings`): who coordinates, default agent kind and folder for new agents, CLI path per
  adapter with "Check again", voice on/off and voice choice (this browser), server URL/port notes.
- **Adapters**: `pi` and `hermes` (see docs/adapters.md for the verified flags). Each is one file in
  `adapters/` plus a line in `adapters/index.ts`; `AgentKind` already had both.
- An agent's first prompt is now stored as a `message` event, so it shows in history and search.
- 43/43 `node --test`; headless Chromium checks for all four pages pass, and the Settings page found the
  real `pi` 0.73.1 through a CLI path override.

### Not done / next ideas
- Hermes has no live tool events; switching it to `hermes-acp` would add them.
- Pi and Hermes still need one real turn each on kenz's machine (no API keys here).
- Voice needs a real try in Chrome.

## Polish (2026-10-16)
- Claude Code with no login gives one clear error ("isn't signed in… run `claude auth login`") instead of
  its reply, an error result and the exit code.
- New `thinking` event: Claude Code thinking blocks, Codex reasoning and OpenCode reasoning text. The CEO page's
  right panel shows the CEO's current turn live (thinking, tools, replies).
- Redesign: black and minimal. Violet (`--think`) is the thinking color and the main accent (New agent, nav hover,
  focus); green working, amber waiting, red error, cyan tools and messages. The 3D office matches.

## Shared context, sessions, permanent history, setup (2026-10-16)
- Security: the API only answers this machine (Host and Origin checks, no `Access-Control-Allow-Origin: *`),
  so a web page in the browser can no longer create or steer agents.
- Permanent history: removing an agent archives it. History lists removed agents (tagged "removed"), and every
  agent change and event is also appended to `~/.agentix/history/*.jsonl`.
- New session and Clear for any agent (CEO page header, a coordinator card on the CEO page, the agent panel,
  `agentix new <id> [--clear]`).
- Shared context (RAG): team brief, notes (`@@remember :: fact` from any agent, or the Context page), BM25 search
  over notes, agent outputs and chosen folders. Workers and the coordinator get the best matches before each task.
- First-run setup at `/setup`: scans the machine with `scan_clis.py`, asks who coordinates (you / an agent /
  you + agent), creates the coordinator (and optionally a CEO), and hands it the team's first task so it spawns
  the workers. "Run setup again" in Settings.
- Checked: 52 server tests; the whole setup flow in headless Chromium with fake CLIs (coordinator spawned two
  workers and saved a note; Clear, Context search and a removed agent in History all worked, no page errors).

## Browser tests

Playwright drives the built dashboard (`packages/web/dist`) against a real server, so rebuild after web changes.
Fake `claude` and `codex` CLIs in `e2e/fakebin` stand in for the agents (no model calls). The server runs on
port 4391 (`E2E_PORT`) with a wiped `$TMPDIR/agentix-e2e` home (`E2E_AGENTIX_HOME`, folder name must contain
"e2e") and `AGENTIX_UPDATE_DELAY_MS=300`. One worker: the tests share the server and run in order (setup, CEO
chat + Clear, Context, History with a removed agent, Office + Agents, foreign Origin gets 403).

```bash
npm ci
npx playwright install --with-deps chromium     # once; CI does this
npm run e2e
PW_CHROMIUM=/opt/pw-browsers/chromium npm run e2e   # this machine: use the preinstalled Chromium instead
```

CI runs them after the dashboard build check and uploads `playwright-report/` when they fail.

## Worktrees, tasks, usage, retention, smarter memory, more agents (2026-10-16)
- Git worktree per worker: a worker in a git repo gets its own branch and folder. The agent panel shows the
  branch and changed files, a Diff view, and Merge (into the repo's checked-out branch) / Discard. Setting and
  a per-agent checkbox turn it off; `@@spawn ... worktree=no` too.
- Task board (`/tasks`): five columns, drag cards between them. The coordinator plans with `@@task`; a worker's
  tasks move to doing / review / blocked on their own. Each desk in the office shows its agent's current task.
- Usage meter: adapters emit `usage` events from the CLI's token counts; "tokens today" in the top bar,
  tokens and cost per agent on the Agents page and in the agent panel.
- Event log retention: the database keeps detailed events for `retentionDays` (30); history files keep all.
- Smarter memory: optional local embeddings through Ollama, fused with BM25. Settings has a Test button; the
  Context page shows which search ran.
- New adapters: Gemini CLI, Aider, Goose (written from their docs, not yet run against the real CLIs).

## Model picker (2026-10-16)
- New agent, setup (coordinator and CEO) and every agent's panel / Agents row let you pick the model, from the list
  each CLI gives (Codex catalog with reasoning levels, OpenCode and Pi provider lists with search, Claude aliases,
  Hermes' configured default) or typed by hand. Empty keeps the CLI's own default. `@@spawn ... model=` too.

## Speed, safety and the missing basics (2026-10-21)
- **Context search is fast now.** It used to re-read and re-count every file under every search folder on
  every search: 2.7 s and a 2.7 s frozen event loop on a 31 MB repo. Files are chunked and counted once
  (re-done only when the file changes), BM25 counts only the query's words, and the search yields to the
  event loop every 32 documents. Same corpus now: 0.3 s cold, 27 ms warm, worst stall 50 ms.
  `searchContext` is async now — every caller awaits it.
- **Task ids never repeat.** `t1, t2, …` come from a counter kept in `tasks.json`; deleting a task no
  longer hands its id to the next one.
- **`GET /api/agents/:id/worktree` no longer touches your index.** It ran `git add --intent-to-add` in
  the worktree, which staged your new files; it now uses a throw-away copy of the index.
- **Notes say who wrote them.** Server, dashboard and the `[SHARED CONTEXT]` block mark a note from an
  agent as "… (a teammate)", so a worker's note is never read as an instruction.
- **CLI**: `agentix spawn` takes `--model` and `--worktree` / `--no-worktree`.
- **Tightened the API's Origin check**: the origin must match the host the request came to (or a known
  dev origin, `AGENTIX_DEV_ORIGINS`); another app on this machine can no longer drive the API.
- **Tooling**: `packages/server/tsconfig.json` + `npm run typecheck` (server, CLI and dashboard),
  ESLint (`npm run lint`), and CI now runs test → typecheck → lint → build → browser tests.
- **README.md** at the repo root: what it is, quick start, CLI, layout, configuration, security.

## Locking the API down, and keeping the office in order (2026-10-22)

Round two of "speed, safety and the missing basics". The server now has limits, answers for
itself, and cleans up after itself.

- **The API can be locked with a token.** `AGENTIX_TOKEN` makes every `/api` request need that
  token: in the `x-agentix-token` header, or as `?token=` (the event stream, which the browser
  opens without headers). Without it the server answers `401`. The server prints the link
  (`http://127.0.0.1:4317/?token=…`) when it starts; the dashboard takes the token from the
  address bar once, keeps it in the browser and drops it from the URL; the CLI sends
  `AGENTIX_TOKEN` from the environment. The dashboard itself stays reachable, so the browser can
  show "token required" instead of a blank page.
- **The office has limits.** `AGENTIX_MAX_AGENTS` (64) refuses a new agent with `429`; 
  `AGENTIX_MAX_CONCURRENT_TURNS` (12) refuses a turn that would run beside too many others;
  `AGENTIX_TURN_TIMEOUT_MS` (30 min) stops a turn that never ends — the agent goes to `error` and
  its task to `blocked`. An agent that leaves the office hands its open tasks back to the board.
- **Commands answer back.** Every `@@` command the server runs is reported to the agent that
  wrote it: a `message` event with the result, and a `[COMMAND RESULTS]` block at the start of its
  next turn. A misspelled verb used to be ignored silently; it is now an error with a suggestion
  (`@@spwan` → "did you mean @@spawn?"), and a failed command gets a turn of its own (at most
  three in a row, so it cannot loop).
- **Nothing blocks the server.** Every git call is asynchronous now, so a slow repository cannot
  freeze the dashboard or the other agents.
- **The stores behave the same.** The JSON fallback appends events to a JSONL file instead of
  rewriting the whole file on every event (it used to grow quadratically: 254 ms for the first
  1000 events, 893 ms for the next 1000). The SQLite store searches text through an FTS5 index
  instead of scanning the table. `store-contract.test.ts` runs the same checks against both.
- **A dead server does not leave agents running.** Every CLI the server starts is remembered in
  `~/.agentix/runs/`; the next server stops the ones a previous one left behind (only when the
  pid still runs the binary Agentix started).
- **A stream replay is bounded**: at most `AGENTIX_SSE_MAX_REPLAY` events (2000) in one go.
- New tests: `safety.test.ts` (limits, timeout, task hand-back, command feedback, orphan cleanup),
  `hardening.test.ts` (token, replay cap), `store-contract.test.ts` (both stores), `perf.test.ts`
  (the search and the event writes stay fast and never block the event loop). 99 server tests.

## AGENTS.md role instructions (2026-10-16)
- `packages/server/roles/AGENTS.md` says how each role should work: "Everyone", then CEO, Coordinator and Worker.
  Every agent gets "Everyone" plus its own section with its first prompt of each session (workers too, not only
  the CEO and coordinator). Copy it to `~/.agentix/AGENTS.md` to edit it; that copy wins. An empty copy turns it off.

## A harness that never loses work (2026-10-23)

Round three of "the office behaves like a harness, not a demo". Everything here is about work that was
being dropped, stranded or hidden.

- **A turn at the office limit waits instead of being dropped.** `AGENTIX_MAX_CONCURRENT_TURNS` used to
  refuse a turn with an error and throw the prompt away: the task stayed on the board forever and nobody
  knew to send it again. Turns now go into a FIFO queue (at most 100) and start on their own as soon as a
  slot frees; the agent shows `queued (N waiting for a turn slot)` and the log says which instruction
  waits. A queued prompt for an agent that got another turn meanwhile becomes that agent's inbox instead.
- **A timeout says what it dropped.** A turn stopped by `AGENTIX_TURN_TIMEOUT_MS` used to leave the
  instructions queued behind it in an inbox nobody would drain, and never told the coordinator. It now
  reports them (`N instruction(s) were not run (the turn timed out): …`) and frees the slot for the queue.
- **Shutdown starts nothing.** `shutdown()` marks the office as stopping, so a turn ending during it cannot
  start the next queued or inbox turn; `resetWorkspace()` clears the flag for the fresh workspace.
- **A restart fixes the board.** Tasks that were `doing` when the server stopped go back to `todo` with a
  task event ("the server restarted while it was being worked on"), so a crashed or killed server no longer
  leaves work hidden in the doing column. And the instruction itself is not lost either: the running turn,
  the queue and waiting messages are kept in `pending.json` and offered again at the next start (see below).
- **A CLI that ignores signals is killed.** Interrupts escalate SIGINT → SIGTERM → SIGKILL (one
  `AGENTIX_KILL_GRACE_MS` between each) and the interrupt waits for all three. A CLI that trapped SIGINT
  and SIGTERM used to keep running after the server had given up on it, still holding its worktree.
- **One event is bounded.** Text is kept up to 100k characters and `data` up to 64k (then replaced by
  `{ truncated: true, bytes }`), so a CLI printing a whole file cannot fill the database, the history file
  or the event stream; the readable text still reaches the dashboard.
- **The coordinator can tell a worker something.** `@@tell <agent>` used to be an error unless the target
  was the CEO ("use @@steer <worker> :: ... to direct workers"), so a note to a busy worker became a red
  error event and an extra result turn. `@@tell` now reaches any agent and never interrupts it: a working
  agent reads the message at its next turn (from its inbox), an idle one starts a turn with it, and the
  message begins `[FROM COORDINATOR <name>]` so the worker knows it did not come from kenz. Bad targets
  (an unknown name, the agent itself) are still errors.
- **History flushes are serialized.** A background flush and an awaited one could overlap, so
  `flushHistory()` could return before a write that another flush had already started had landed, and the
  lines could reach the file out of order. Writes now go through one promise chain, so awaiting it means
  the file has everything buffered before the call (the full suite showed this as a flaky history read).
- **A restart no longer throws away the work in flight.** The running turn, the queue behind the office
  limit and every waiting inbox message used to live only in `SessionManager`'s maps: stopping the server
  (or killing it) lost the instruction an agent was following while the task board only said "todo" again,
  and dropped turns that were waiting in the queue. They are now written to `$AGENTIX_HOME/pending.json`
  on every turn start/end and queue/inbox change, and the next server offers them again after it has
  stopped the previous server's CLIs. An interrupted turn is re-issued with a `[AGENTIX] The server
  restarted in the middle of your last turn …` preamble (check the work, then finish it) instead of being
  silently repeated, queued turns keep their own prompt, and saved work for an agent that was removed
  meanwhile is dropped with a log line. What came of the `@@` commands an agent wrote is saved too, so a
  coordinator still sees its `[COMMAND RESULTS]` after the restart instead of spawning the same worker
  twice. `resetWorkspace()` deletes the journal.
- New tests: `robustness.test.ts` (queue, timeout report, task recovery, SIGKILL, event caps, shutdown),
  `pending.test.ts` (journal while running, restart restores turn + queue + inbox, no duplication after a
  normal turn, stale work dropped, no stacked restart note, command results delivered once) and one in
  `coordinator.test.ts` (a message to a working worker: no error, no interruption, delivered on its next
  turn). 113 server tests.

## Audit follow-up: process safety and recovery (2026-11-06)

- A timed-out or stubborn CLI stays registered as active until its process group exits. This keeps its
  working folder reserved and prevents a second worker from editing beside it. Shutdown waits for the
  adapters to confirm exit before releasing the server lock. Process records use atomic replacement.
- Valid JSON with the wrong top-level shape is quarantined for tasks, approvals, pending work, and
  settings. A damaged primary JSON store now stops startup with a recovery message and keeps the source
  file intact instead of silently opening an empty office.
- History searches now use the authenticated API helper, show a retry action on errors, and ignore stale
  responses when filters change. Blocked assigned tasks have a one-click Retry action; task deletion asks
  before removing it. `agentix doctor` reports the platform's process-cleanup capability.
- Remaining boundary: permission requests are a coordinator workflow, not a universal pre-execution tool
  gate. Some agent CLIs auto-approve tools, and true enforcement needs adapter-specific approval plumbing
  or an OS-level sandbox. Verified process-tree cleanup currently works on Linux; macOS restart cleanup
  cannot verify old process identities, and Windows cleanup targets the direct CLI only.
- Verification: 137 server tests pass; typecheck, lint, production build, `npm audit`, and live dashboard,
  authenticated API, CLI, and doctor smoke checks pass under Node 22.

## Audit follow-up: scheduler and dashboard edge cases (2026-11-06)

- Removing an agent now removes its waiting turns first, waits for the active CLI to exit, and keeps its
  workspace occupied until then. Steering takes priority over queued tasks, concurrent steers use the
  latest instruction, and permission decisions for agents being removed are rejected without being marked
  applied. Regression tests cover removal, task retries, steering priority, and simultaneous steers.
- SSE streams disconnect when the response applies backpressure, rather than buffering an unlimited live
  feed. JSON request parsing now preserves UTF-8 when a multibyte character crosses network chunks.
- The JSON fallback validates stored agent/event records, writes snapshots and event rewrites atomically,
  logs write failures, and exposes persistence errors through authenticated `GET /api/health`. Settings
  shows storage health; embedding tests stop if saving the edited settings failed.
- Context search ignores stale responses and agent-output hits link to History. The task owner picker now
  lists only workers, matching which roles can execute assigned tasks.
- Verification: 141 server tests pass; typecheck, lint, production build, and `npm audit` pass.

## Audit follow-up: queued work, API contracts and dashboard polish (2026-11-06)

- A replacement steer or permission approval that arrives while a stubborn CLI is exiting is now
  delivered after that process ends, even when the old turn was aborted. Starting a new session
  returns `409` while the old CLI is still alive instead of clearing its session underneath it;
  interrupted tasks return to `todo` once the process exits.
- An empty saved API token now fails closed with a recovery message instead of silently disabling
  authentication. Agent and task endpoints validate input types, and only workers can own tasks.
  Static `HEAD` requests return headers without a response body.
- History search and event filters are saved in the URL, so views can be bookmarked and shared.
  Empty type filters now show no events. Coordinator mode saves, message drafts and context-folder
  saves report failures without discarding the user's input; navigation fits small screens.
- On Linux, a process group containing only zombies now counts as finished. Zombie entries cannot
  run or be killed again, and previously caused the orphan-cleanup test to intermittently time out.
- Verification: 144 server tests pass; typecheck, lint, production build, `npm audit`, and
  `git diff --check` pass. The shell defaults to Node 18, below the declared Node 20.19+/22.12+
  minimum; verification used Node 22.23.4 from the local npm cache.

## Frontend accessibility and responsive pass (2026-11-06)

- New Agent, New Session and Change Model dialogs now expose dialog semantics, move focus inside,
  trap Tab navigation, close on Escape or backdrop click, and restore focus when closed. Closing is
  disabled during saves, and dialog errors are announced.
- Keyboard users get a consistent focus ring, reduced-motion preferences are respected, and the CEO
  voice button supports keyboard hold/toggle behavior without hijacking Space from other controls.
- History gains an agent picker on narrow screens, labels for search/resume controls, and announced
  selected states for event filters. Task controls have clearer names and instructions; the task form
  stacks on small screens and the horizontal board shows a scroll cue.
- Setup is centered on wide screens, and the top bar now uses a named navigation landmark.
- Verification: typecheck, lint, production build and source `git diff --check` pass. The dialog's
  accessible name, initial focus, Escape close and focus restoration were checked in a browser.

## Visual polish pass (2026-11-06)

- Replaced near-black surfaces and low-contrast gray copy with a layered blue-charcoal palette,
  brighter secondary text, subtle violet lighting and clearer card/input borders.
- Refined the top bar, selected navigation, buttons, cards, task columns and dialogs with consistent
  radii, spacing, hover states and softer elevation. The setup flow now sits in a centered column on
  wide displays.
- Verification: typecheck, lint, production build and source `git diff --check` pass; the setup page
  was reviewed in a 1280 px browser viewport.

## Task review and rework loop (2026-11-06)

- Review-column tasks now have explicit Approve and Request changes actions. Approval moves the task
  to Done. Feedback is required before rework; submitting it saves the feedback as the task note,
  returns the task to To do, and the existing scheduler sends it back to its assigned worker.
- Submission errors keep the feedback in the form, and review actions prevent duplicate requests
  while a save is in flight. Unassigned tasks retain the feedback without claiming a worker was
  notified.
- Verification: typecheck, lint, production build and `git diff --check` pass.

## Bounded recovery for transient task failures (2026-11-06)

- A worker task now retries once for recognized transient network/service failures such as 429/503,
  connection resets and temporary unavailability. Timeouts, auth/configuration errors and other
  failures still block the task for a human/coordinator decision; the retry cannot loop indefinitely.
- Task attempt counts are saved before a worker starts, survive restarts, appear on task cards after
  a retry and default to zero when loading older task files. The failure reason stays in the task note;
  coordinators receive a retry update. If the retry cannot enter the queue, the task becomes blocked
  with a clear explanation.
- Verification: typecheck, lint, production build and source `git diff --check` pass.

## Follow-up logic and harness audit (2026-11-06)

- Queued task starts are counted even if the board was manually moved to Doing while waiting for a slot.
- Review feedback now reaches the assigned worker. Task notes preserve earlier feedback and clarify the
  latest retry, final failure, timeout or successful rework result.
- CEO push-to-talk releases on keyup even after focus moves, and on window blur.
- Browser test setup now disables auth only in its disposable test server, uses the current navigation
  landmark and verifies agents work in their configured folder instead of expecting removed worktrees.
- Verification: typecheck, lint, build, 144 server tests and 10 browser tests pass with Node 22.23.4;
  `git diff --check` passes.

## UI efficiency pass (2026-11-06)

- Approval refreshes now pause in hidden tabs, resume immediately when visible, and never overlap.
- The office chooses each agent's task in one scan instead of two; the top bar and Agents filters memoize
  their derived collections and aggregate status/token totals with single passes.
- Coordinator summaries query each agent's latest output directly instead of loading and filtering its
  last 50 mixed events; the JSON fallback scans backward and stops at the match.
- Verification: typecheck, lint, production build and `git diff --check` pass.

## Visual refinement pass (2026-11-06)

- Refined the blue-charcoal theme with a softer ambient glow, richer layered panels, stronger selected
  states, cleaner form focus, and more tactile hover/press feedback.
- Added a small setup eyebrow and accent rule; setup steps now have distinct, restrained color washes.
- Reviewed the setup layout at desktop and mobile widths. Typecheck, lint, production build and source
  `git diff --check` pass.

## Agent coordination handoff (2026-11-06)

- Assigned workers now receive the current team board when their turn actually starts, including
  task ownership, statuses, task notes and pending permission requests. This keeps queued tasks from
  acting on stale coordination information and helps workers flag dependencies instead of duplicating
  or taking over work.
- Verification: typecheck, lint and `git diff --check` pass.

## Server handoff audit (2026-11-06)

- Permission-approved task resumes now include the original task title and saved task context in both
  direct approvals and restart recovery, so the worker has the work scope on its fresh turn.
- SSE replay now buffers live events until history is sent and skips already-sent event IDs, preventing
  duplicate chat items when a new event lands during replay.
- Verification: typecheck, lint and `git diff --check` pass.

## JSON persistence audit (2026-11-06)

- Migrating the JSON fallback now merges old embedded events with the append-only journal and writes
  the new snapshot format, so a restart cannot replace newer events with a stale snapshot.
- A crash-truncated final event line is separated before appending again; the damaged bytes stay on
  disk for recovery, while later valid events remain readable.
- Verification: typecheck, lint and `git diff --check` pass.

## Shared-context cache audit (2026-11-06)

- Semantic embeddings now keep at most 2,000 in-memory vectors and compact the on-disk cache after it
  crosses 32 MiB. Older oversized caches are reset because embeddings can be rebuilt from source text.
- Ollama responses are checked for consistent, finite vectors within a bounded dimension before caching;
  incompatible cached vectors are skipped during scoring.
- Verification: typecheck, lint and `git diff --check` pass.
