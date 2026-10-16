# Agentix API Reference

## REST API

The server listens on 127.0.0.1 only and answers only requests for this machine: a `Host` other than
`localhost`, `127.0.0.1` or `[::1]` gets `403` (blocks DNS rebinding), and so does an `/api` request whose
`Origin` is another site. No CORS headers are sent, so other web pages can't call the API.

All routes are relative to `http://127.0.0.1:4317` (`AGENTIX_PORT` changes the port).

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
  "replace": false
}
```

Only `kind` is required. `role` defaults to `worker`, `avatarId` to `"random"` (or 0–9), `cwd` to
`~/.agentix/workspace` (must be absolute; created if missing). With `prompt`, the first turn starts at once.

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
- `GET /api/context/search?q=...&limit=10`: BM25 keyword search over notes, agent outputs and the text
  files under `contextPaths`. Hits: `{ source: note|output|file, title, text, score, ... }`

Before every worker and coordinator turn (when `sharedContext` is on), the prompt starts with a
`[SHARED CONTEXT]` block: the brief, the 5 best hits for the task (never the agent's own output) and how to
add a note. Any agent can save a note with a line `@@remember :: <fact>`.

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
"sharedContext": true, "contextPaths": ["/abs/docs"], "setupDone": false }`.
PUT takes any subset. `coordinatorMode`: `human` (no coordinator updates, its @@ commands are ignored),
`agent` (the dashboard routes kenz's worker instructions through the coordinator), `both` (default).
Stored in `$AGENTIX_HOME/settings.json`.

### POST `/api/coordinator/ask`

`{ "text": "...", "about": "<agent id>?" }`: a note from kenz to the coordinator. Shown as a `message`
on the coordinator and delivered in its next `[AGENTIX UPDATE]`. `409` if there is no coordinator.

## Coordinator and CEO commands

Lines in a coordinator's output (the server runs them; see `server/src/commands.ts`):

```
@@spawn kind=codex name=Rook avatar=random cwd=/abs/path :: <task>
@@steer <agent id or name> :: <instructions>
@@stop <agent id or name>
@@tell ceo :: <report>
@@remember :: <fact for the shared context>
```

The CEO may only write `@@tell coordinator :: <message>` (and `@@remember`). Workers may write `@@remember`. Every CEO turn starts with a `[TEAM STATUS]` digest.

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
| `error` | Error occurred |

## History on disk

Besides the database (`$AGENTIX_HOME/agentix.db`), everything is appended to plain JSON Lines files that
are never rewritten: `$AGENTIX_HOME/history/agents.jsonl` (one line each time an agent is created, changed,
gets a session or is removed) and `$AGENTIX_HOME/history/<agentId>.jsonl` (every event of that agent).

## Dashboard

Any non-`/api` GET serves the built dashboard from `packages/web/dist` (override with `AGENTIX_WEB_DIST`);
unknown paths get `index.html` so client routes like `/history` work on reload.
