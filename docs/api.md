# Agentix API Reference

## REST API

The server listens on 127.0.0.1 only and answers only requests for this machine: a `Host` other than
`localhost`, `127.0.0.1` or `[::1]` gets `403` (blocks DNS rebinding), and so does an `/api` request whose
`Origin` is another site. No CORS headers are sent, so other web pages can't call the API.

All routes are relative to `http://127.0.0.1:4317` (`AGENTIX_PORT` changes the port).

### GET `/api/adapters/:kind/models[?refresh=1]`

The models a CLI can run with, for the model picker: `{ models: [{ id, label?, group?, description?, efforts?, defaultEffort? }], current?, error? }`.
`current` is the CLI's configured default when Agentix can read it. Cached for 10 minutes.

| Kind | Listed from | Model flag |
|---|---|---|
| codex | `codex debug models` (or `~/.codex/models_cache.json`), hidden models left out | `-c model="…"` (+ `-c model_reasoning_effort="…"`) |
| opencode | `opencode models` (provider/model per line) | `-m provider/model` |
| pi | `pi --list-models` | `--model provider/id` |
| claude | the aliases fable, opus, sonnet, haiku | `--model` |
| hermes | its configured default (`~/.hermes/config.yaml`) | `-m` |
| gemini, aider | none (type a name) | `-m` / `--model` |
| goose | none (type a name) | `GOOSE_MODEL` |

### GET `/api/adapters`

Returns which agent CLIs are installed and their versions.

**Response:**
```json
{
  "adapters": [
    { "kind": "codex", "installed": true, "version": "codex-cli 0.162.1" },
    { "kind": "pi", "installed": false },
    { "kind": "opencode", "installed": true, "version": "1.0.0" }
  ]
}
```

### GET `/api/agents`

List all agents.

**Response:**
```json
{
  "agents": [
    {
      "id": "a_7k2x",
      "name": "Nova",
      "kind": "codex",
      "role": "worker",
      "avatarId": 0,
      "cwd": "/home/user/.agentix/workspace",
      "status": "idle",
      "activity": "idle",
      "nativeSessionId": "sess_abc123",
      "createdAt": 1729000000000
    }
  ],
  "lastEventId": 42
}
```

`lastEventId` (the newest event id) comes with the list, so a client can take this snapshot and then
open `/api/stream?after=<lastEventId>` without replaying what it already has.

### POST `/api/agents`

Create a new agent.

**Body:**
```json
{
  "kind": "codex",
  "role": "worker",
  "name": "Nova",
  "avatarId": "random",
  "cwd": "/path/to/project",
  "prompt": "fix the failing test",
  "replace": false,
  "worktree": true,
  "model": "gpt-6.1-sol:high"
}
```

Only `kind` is required. `role` defaults to `worker`, `avatarId` to `"random"` (or 0–9), `cwd` to
`~/.agentix/workspace` (must be absolute; created if missing). With `prompt`, the first turn starts at once.
`model` is passed to the CLI's model flag on every turn (empty = the CLI's own default); for Codex,
`<model>:<level>` also sets the reasoning level. `PATCH /api/agents/:id` takes `model` too (`null` or `""` clears
it), used from the agent's next turn. A worker whose `cwd` is inside a git repository gets its own worktree and branch (see Worktrees) unless
`"worktree": false` or the `worktrees` setting is off.

**Response:** `201` with the created agent. `400` for an unknown kind/role/avatar, `409` if a
coordinator or CEO already exists (body has `data.existing`); send `"replace": true` to demote it to worker.

### PATCH `/api/agents/:id`

Update agent properties.

**Body:** `{ "name": "NewName", "avatarId": 3, "role": "coordinator", "replace": true }` — same 409 rule for roles.

### GET `/api/agents/:id`

One agent. `404` if unknown.

### DELETE `/api/agents/:id`

Stop and remove an agent. Its record and every event are kept: it gets `archivedAt`, leaves
`GET /api/agents`, and stays in `GET /api/agents?archived=1`, `/api/events` and `/api/agents/:id/events`.

### POST `/api/agents/:id/session`

`{ "clear": false }`: interrupt the agent and drop its native session, so the next message starts a new
conversation (the coordinator and CEO get their role instructions again). Emits a `session` event; with
`clear: true` dashboards hide the events before it (they stay in the history). CLI: `agentix new <id> [--clear]`.

### POST `/api/agents/:id/steer`

Send a steering instruction. If the agent is busy its turn is interrupted (SIGINT, then SIGTERM after
3 s), then a new turn starts that **resumes the same native session** (Codex thread, OpenCode session,
Claude session). Steering a worker also queues an `[AGENTIX UPDATE]` for the coordinator.

**Body:** `{ "text": "use pnpm instead", "from": "user" }`

### POST `/api/agents/:id/interrupt`

Stop the current turn (status becomes `stopped`). No-op when idle.

### GET `/api/agents/:id/events?after=N`

Get event history for an agent (removed ones too). `after` filters to events with id > N.

### Shared context

- `GET /api/context`: `{ brief, notes, contextPaths, sharedContext, dir }`
- `PUT /api/context/brief` `{ text }`: the team brief (`$AGENTIX_HOME/context/brief.md`)
- `POST /api/context/notes` `{ text }` / `DELETE /api/context/notes/:id`: notes (`context/notes.jsonl`)
- `GET /api/context/search?q=...&limit=10`: search over notes, agent outputs and the text files under
  `contextPaths`. Returns `{ hits: [{ source: note|output|file, title, text, score, ... }], embeddingError? }`.
  Always BM25 keywords; with `embeddings.provider: "ollama"` it also ranks by meaning (Ollama `/api/embed`,
  cached in `context/embeddings.jsonl`) and fuses both lists (reciprocal rank fusion). If Ollama fails it
  falls back to keywords and says why in `embeddingError`.
- `POST /api/context/embeddings/test`: embeds a test sentence with the saved settings: `{ ok, dimensions | error }`.

Before every worker and coordinator turn (when `sharedContext` is on), the prompt starts with a
`[SHARED CONTEXT]` block: the brief, the 5 best hits for the task (never the agent's own output) and how to
add a note. Any agent can save a note with a line `@@remember :: <fact>`.

### Worktrees

Each such worker works in `$AGENTIX_HOME/worktrees/<agentId>` on branch `agentix/<name>-<id>`, started from
the repo's current commit, so workers in one repo never overwrite each other.

- `GET /api/agents/:id/worktree`: `{ branch, repo, path, target, files: [{ status, path }], commits, stat, diff, truncated }`,
  everything changed since the branch's base (new files included; diff capped at 200 KB). `404` without a worktree.
- `POST /api/agents/:id/worktree/merge`: commits the work on the branch and merges it (`--no-ff`) into the
  branch the repo has checked out. `{ merged, into }`. A failed merge is aborted and nothing changes (`409`).
  `409` while the agent is running. The coordinator is told.
- `POST /api/agents/:id/worktree/discard`: resets the worktree to its base and deletes new files.
- Removing the agent commits leftover work to its branch (kept if it has new commits) and deletes the folder.

### Tasks

The task board, stored in `$AGENTIX_HOME/tasks.json`. A task: `{ id: "t1", title, status, owner?, by, note?, createdAt, updatedAt }`,
`status` one of `todo`, `doing`, `review`, `done`, `blocked`.

- `GET /api/tasks`: `{ tasks }`
- `POST /api/tasks` `{ title, owner?, status?, note? }`: `201 { task }`
- `PATCH /api/tasks/:id` `{ title?, status?, owner? (null clears), note? }`: `{ task }`
- `DELETE /api/tasks/:id`

The server moves a worker's own tasks: `todo`/`review`/`blocked` to `doing` when a turn starts, `doing` to
`review` when it ends (`blocked` if it failed). `@@spawn ... :: <task>` adds the task for the new worker.
The coordinator's `[TEAM STATUS]`/updates list open tasks.

### GET `/api/usage`

`{ total: [...], today: [...] }`, one row per agent: `{ agentId, turns, input, output, cacheRead, cacheWrite, cost }`.
`today` counts from local midnight. Summed from `usage` events, which adapters emit when the CLI reports
token counts (and cost, when it reports it).

### Event retention

Every 6 hours (and at start) the server deletes events older than `retentionDays` (default 30, `0` keeps
everything) from the database, except `agent.*`, `session`, `usage` and `task` events. The history files on
disk are never trimmed.

### GET `/api/setup/scan`

Runs `packages/server/scripts/scan_clis.py` (Python 3, standard library only; a PATH-only Node scan if there
is no Python) and returns `{ scanner, platform, found: [{ kind, name, path, version, runs, on_path, all_paths, supported }] }`.
The dashboard's `/setup` page uses it on first launch (`setupDone` false and no agents).

### GET `/api/events`

Search the whole history, newest first. Query: `q` (case-insensitive text match), `agent` (id),
`type` (comma-separated), `before` (event id, for the next page), `limit` (default 200, max 1000).
Response: `{ events, stats }`, where `stats` is `[{ agentId, count, lastTs }]` for every agent.

### GET / PUT `/api/settings`

`{ "coordinatorMode": "both", "cliPaths": { "codex": "/opt/bin/codex" }, "defaultKind": "codex", "defaultCwd": "",
"sharedContext": true, "contextPaths": ["/abs/docs"], "setupDone": false, "worktrees": true, "retentionDays": 30,
"embeddings": { "provider": "off", "url": "http://127.0.0.1:11434", "model": "nomic-embed-text" } }`.
PUT takes any subset. `coordinatorMode`: `human` (no coordinator updates, its @@ commands are ignored),
`agent` (the dashboard routes kenz's worker instructions through the coordinator), `both` (default).
Stored in `$AGENTIX_HOME/settings.json`.

### POST `/api/coordinator/ask`

`{ "text": "...", "about": "<agent id>?" }`: a note from kenz to the coordinator. Shown as a `message`
on the coordinator and delivered in its next `[AGENTIX UPDATE]`. `409` if there is no coordinator.

## Coordinator and CEO commands

Lines in a coordinator's output (the server runs them; see `server/src/commands.ts`):

```
@@spawn kind=codex name=Rook avatar=random cwd=/abs/path model=gpt-6-sol :: <task>
@@steer <agent id or name> :: <instructions>
@@stop <agent id or name>
@@tell ceo :: <report>
@@remember :: <fact for the shared context>
@@task owner=Rook :: <title>                 # add a task to the board
@@task t3 status=done note="merged" :: <new title (optional)>   # change one
```

The CEO may only write `@@tell coordinator :: <message>` (and `@@remember`). Workers may write `@@remember`
and `@@task <id> status=... note=...` for their own tasks. `@@spawn ... worktree=no` skips the worktree. Every CEO turn starts with a `[TEAM STATUS]` digest.
After a CEO request, Agentix waits for a coordinator reply, sends up to two non-interrupting follow-ups,
and reports an issue after three unanswered requests. The timeout is 30 seconds by default and can be adjusted
with `AGENTIX_CEO_REPLY_TIMEOUT_MS`. A coordinator response clears the watchdog.

### GET `/api/stream`

**SSE** endpoint. Streams all events for all agents. Each message is
`id: <event id>` / `event: <event type>` / `data: <AgentEvent JSON>`, so listen for named events
(or read the raw stream; `agentix watch` does).

Replay before live events: from the `Last-Event-ID` header or `?after=N` if given (everything after
it), otherwise the last `?tail=N` events (default 100).

### GET `/api/agents/:id/stream`

**SSE** endpoint for a single agent; same replay rules.

## Events

| Type | Description |
|---|---|
| `agent.created` | New agent spawned |
| `agent.updated` | Agent properties changed |
| `agent.removed` | Agent removed |
| `output` | Agent produced output |
| `tool` | Agent ran a tool/command |
| `thinking` | The model's reasoning text (Claude Code thinking, Codex and OpenCode reasoning) |
| `status` | Status/activity change |
| `steer` | Human/agent sent instructions |
| `message` | Message to an agent, e.g. `[AGENTIX UPDATE]` from `system` to the coordinator |
| `session` | New native session; `data.clear` true means dashboards hide earlier events |
| `usage` | Tokens for one turn: `data` is `{ input, output, cacheRead?, cacheWrite?, cost? }` |
| `task` | A task was created or changed; `data` is the task (`deleted: true` when removed) |
| `error` | Error occurred |

## History on disk

Besides the database (`$AGENTIX_HOME/agentix.db`), everything is appended to plain JSON Lines files that
are never rewritten: `$AGENTIX_HOME/history/agents.jsonl` (one line each time an agent is created, changed,
gets a session or is removed) and `$AGENTIX_HOME/history/<agentId>.jsonl` (every event of that agent).

## Dashboard

Any non-`/api` GET serves the built dashboard from `packages/web/dist` (override with `AGENTIX_WEB_DIST`);
unknown paths get `index.html` so client routes like `/history` work on reload.
