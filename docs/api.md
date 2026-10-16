# Agentix API Reference

## REST API

All routes are relative to `http://127.0.0.1:4317` (`AGENTIX_PORT` changes the port).

### GET `/api/adapters`

Returns which agent CLIs are installed and their versions.

**Response:**
```json
{
  "adapters": [
    { "kind": "mock", "installed": true, "version": "mock" },
    { "kind": "codex", "installed": false },
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
      "kind": "mock",
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
  "kind": "mock",
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

Stop and remove an agent.

### POST `/api/agents/:id/steer`

Send a steering instruction. If the agent is busy its turn is interrupted (SIGINT, then SIGTERM after
3 s), then a new turn starts that **resumes the same native session** (Codex thread, OpenCode session,
Claude session). Steering a worker also queues an `[AGENTIX UPDATE]` for the coordinator.

**Body:** `{ "text": "use pnpm instead", "from": "user" }`

### POST `/api/agents/:id/interrupt`

Stop the current turn (status becomes `stopped`). No-op when idle.

### GET `/api/agents/:id/events?after=N`

Get event history for an agent. `after` filters to events with id > N.

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
| `status` | Status/activity change |
| `steer` | Human/agent sent instructions |
| `message` | Message to an agent, e.g. `[AGENTIX UPDATE]` from `system` to the coordinator |
| `error` | Error occurred |

## Dashboard

Any non-`/api` GET serves the built dashboard from `packages/web/dist` (override with `AGENTIX_WEB_DIST`);
unknown paths get `index.html` so client routes like `/history` work on reload.
