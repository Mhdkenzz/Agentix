# Agentix

A local control room for AI coding agents. One small server, one CLI, one web dashboard.

Agentix runs the agent CLIs you already have (Codex, OpenCode, Claude Code, Pi, Hermes, Gemini,
Aider, Goose) as **agents** you can spawn, watch, steer and stop — live, in a 3D office in the browser
or from the terminal. Agents get roles (CEO, coordinator, worker), share a memory and work on a task
board.

Everything runs on your machine. One server at a time may use each data folder. The server listens on `127.0.0.1` only, keeps its data in
`~/.agentix`, and never calls a model API itself — the agent CLIs do that.

Node 20.19+ or 22.12+ is required to run Agentix and build the dashboard. The server uses `tsx` to
run its TypeScript sources; on Node versions without `node:sqlite`, it uses the built-in JSON store
instead.

---

## Quick start

```bash
npm install                # once
npm run server             # http://127.0.0.1:4317 — dashboard + API
```

Open <http://127.0.0.1:4317>. The first run scans your machine for installed agent CLIs and walks
you through setup (who coordinates, which model, which folder).

Without a dashboard:

```bash
node packages/cli/src/agentix.ts doctor            # what's installed, is the server up
node packages/cli/src/agentix.ts spawn codex --name Rook "fix the failing test"
node packages/cli/src/agentix.ts ls
node packages/cli/src/agentix.ts watch               # live event feed
```

---

## What you get

**A 3D office.** Every agent has a desk (the coordinator a glass office, the CEO a raised corner).
Avatars animate with their real state: thinking, working, waiting for input, errored. Click one to
open its live log, steer it, see its token usage and diff.

**Roles that talk to each other.** The coordinator plans the work and spawns workers; the CEO talks
to the coordinator only, with a live digest of the whole team. Both receive role-specific orchestration
skills. Workers ask the coordinator before expanding their assignment or taking consequential actions.
You can coordinate by hand instead (`human` mode), or let the coordinator route your instructions
(`agent` mode), or both.

**Shared memory.** A team brief, notes any agent can save with `@@remember :: <fact>`, and BM25 (plus
optional local embeddings via Ollama) search over notes, past agent output and the folders you choose.
Agents get the best matches in front of every task.

**A task board** that moves on its own: `todo → doing → review` as agents work, `blocked` when a turn
fails.

**Saved permission approvals.** Workers can ask the coordinator for approval. Agentix saves each request,
pauses its active task, and records an explicit decision. Pending requests remain available on the Tasks
page after a restart.

**One working folder.** Agents use the folder you choose directly. Agentix runs one turn at a time for
agents whose working folders overlap, including symlink paths; separate folders allow parallel work.

**Permanent history.** Every event is in SQLite and in plain JSONL files under `~/.agentix/history/`.
Each session is listed as its own saved chat in History. Removing an agent archives it; its history
stays searchable. Text search runs on an index, not on a full scan, and a busy agent does not slow
the server down with a write per event.

---

## CLI

```
agentix server                          Start the server (AGENTIX_PORT, default 4317)
agentix doctor                          Check node, store, process cleanup and installed agent CLIs
agentix spawn <kind> [opts] "<prompt>"  Spawn an agent
    --role worker|coordinator|ceo  --avatar 0-9|random  --name N  --cwd DIR
    --model M  --replace
agentix ls                              List agents
agentix logs <id> [-f]                  Show (or follow) an agent's events
agentix steer <id> "<text>"             Interrupt if busy, then continue the session with <text>
agentix stop <id>                       Stop the current turn
agentix new <id> [--clear]              Fresh session for the agent (--clear also hides old messages)
agentix rm <id>                         Stop and remove the agent (history is kept)
agentix remember "<fact>"               Add a note to the team's shared context
agentix watch                           Live feed of all agents
```

`agentix` talks to the server over HTTP and SSE. `server` and `doctor` run locally.

---

## Layout

```
packages/server   the server: REST + SSE API, agent sessions, context search, tasks
packages/cli      the `agentix` command
packages/web      the dashboard (Vite + React + three.js)
packages/shared   types shared by all three
docs/api.md       every route, event and command
docs/adapters.md  the CLI flags each agent adapter uses (verified against the real CLIs)
e2e               Playwright browser tests
```

The server is plain `node:http` with no runtime dependencies. The dashboard is the only part that
needs npm packages.

---

## Development

```bash
npm run dev:web        # Vite on :5173, proxies /api to :4317
npm run build          # builds the dashboard into packages/web/dist (served by the server at /)
npm test               # server + CLI tests (node:test, no runner to install)
npm run typecheck      # tsc for the server, the CLI and the dashboard
npm run lint           # ESLint
npm run e2e            # Playwright browser tests against the built dashboard
```

The built dashboard (`packages/web/dist`) is committed, so `agentix server` works on a machine
without npm. **Rebuild and commit it after changing `packages/web/src`** — CI fails if it is stale.

After a web change: `npm run build && npm run e2e`.

---

## Configuration

Settings live in `~/.agentix/settings.json` and are editable in the dashboard's Settings page:
who coordinates, the default agent kind and folder, per-adapter CLI paths, shared context on/off
and the folders to search, event retention, and optional local embeddings
(Ollama) for meaning search.

Environment variables:

| Variable | Meaning |
|---|---|
| `AGENTIX_PORT` | server port (default `4317`) |
| `AGENTIX_URL` | server URL the CLI talks to |
| `AGENTIX_HOME` | data directory (default `~/.agentix`) |
| `AGENTIX_WEB_DIST` | folder the dashboard is served from |
| `AGENTIX_STORE=json` | force the JSON store instead of SQLite |
| `AGENTIX_TOKEN` | override the saved API token (see Security) |
| `AGENTIX_<KIND>_BIN` | path to one agent CLI (e.g. `AGENTIX_CODEX_BIN`) |
| `AGENTIX_UPDATE_DELAY_MS` | how long coordinator updates are batched (default 5000) |
| `AGENTIX_CEO_REPLY_TIMEOUT_MS` | how long the CEO waits for the coordinator (default 30000) |
| `AGENTIX_MAX_AGENTS` | how many agents may be in the office at once (default 64) |
| `AGENTIX_MAX_CONCURRENT_TURNS` | how many turns may run at the same time; more wait in a queue (default 12) |
| `AGENTIX_MAX_TURN_OUTPUT_BYTES` | maximum combined CLI output per turn (default 20 MiB, capped at 256 MiB) |
| `AGENTIX_TURN_TIMEOUT_MS` | when a turn is stopped for running too long (default 1800000 = 30 min) |
| `AGENTIX_SSE_MAX_REPLAY` | how many events one event-stream replay may contain (default 2000) |
| `AGENTIX_KILL_GRACE_MS` | how long an interrupted CLI may take to exit after SIGINT, and again after SIGTERM, before SIGKILL (default 3000) |

The server also keeps itself out of trouble: a turn that runs too long is stopped (the agent goes to
`error`, its task to `blocked`), too many agents at once is refused with a clear error, extra turns at
the same time wait in a queue (nothing is dropped), an agent that leaves the office hands its open
tasks back to the board, tasks that were being worked on when the server died go back to `todo`, and
the CLIs of a server that died are stopped when the next one starts. A server that stops or dies
mid-work leaves the instruction it was running, the queue and any waiting messages in `pending.json`;
the next start offers them again (an interrupted turn is resumed with a note to check its work first),
so a restart costs seconds instead of a task.

---

## Security

The API answers only this machine: a `Host` other than `localhost`/`127.0.0.1` gets `403` (blocks
DNS rebinding), and so does any `/api` request with a foreign `Origin`. No CORS headers are sent,
so a web page you have open in the same browser cannot spawn or steer agents. The server binds to
the loopback interface only. Agent CLIs keep their own credentials; Agentix never stores them.

By default, Agentix creates a random API token in `~/.agentix/api-token` with owner-only file
permissions. `AGENTIX_TOKEN` overrides that saved token. Every `/api` request needs it, in the
`x-agentix-token` header or as `?token=` (the event stream, which the browser opens without headers,
takes the query form). The server prints a tokenized dashboard link when it starts; the dashboard
keeps the token in the browser. `AGENTIX_AUTH=off` disables authentication for local development only.

Processes running as the same OS user can still read the token. Permission requests are detected from agent output, so a CLI may have acted
before it emits a request; this workflow is not an operating-system sandbox.

Data on disk (`~/.agentix`): the SQLite database, `context/` (brief, notes, embedding cache),
`history/` (JSONL event log), `tasks.json`, `approvals.json` and `pending.json` (work in flight). Existing worktree
folders and branches from older versions are left in place; Agentix no longer manages them.
