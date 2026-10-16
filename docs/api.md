# Agentix API Reference

## REST API

All routes are relative to `http://127.0.0.1:4317`.

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
  ]
}
```

### POST `/api/agents`

Create a new agent.

**Body:**
```json
{
  "kind": "mock",
  "role": "worker",
  "name": "Nova",
  "avatarId": 0,
  "cwd": "/path/to/project",
  "prompt": "fix the failing test"
}
```

**Response:** `201` with the created agent.

### PATCH `/api/agents/:id`

Update agent properties.

**Body:** `{ "name": "NewName", "avatarId": 3, "role": "coordinator" }`

### DELETE `/api/agents/:id`

Stop and remove an agent.

### POST `/api/agents/:id/steer`

Send a steering instruction. Interrupts current turn if busy.

**Body:** `{ "text": "use pnpm instead", "from": "user" }`

### POST `/api/agents/:id/interrupt`

Stop the current turn.

### GET `/api/agents/:id/events?after=N`

Get event history for an agent. `after` filters to events with id > N.

### GET `/api/stream`

**SSE** endpoint. Streams all events for all agents.

Supports `Last-Event-ID` header for reconnection.

### GET `/api/agents/:id/stream`

**SSE** endpoint for a single agent.

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
| `message` | Agent-to-agent message |
| `error` | Error occurred |
