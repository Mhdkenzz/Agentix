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
`AGENTIX_STORE=json` (force the JSON fallback), `AGENTIX_CODEX_SANDBOX`, `AGENTIX_UPDATE_DELAY_MS`
(coordinator batching, default 5000).

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

## Next: Step 2 — live 3D office dashboard
Install npm, scaffold `packages/web` (Vite + React + @react-three/fiber + drei + Zustand), proxy `/api`
to 4317, and have the server serve `packages/web/dist` at `/`. The stream is ready: subscribe to
`/api/stream` named events.
