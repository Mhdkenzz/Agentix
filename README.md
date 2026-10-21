# Agentix

A local control room for AI coding agents. One small server, one CLI, one web dashboard.

Agentix runs the agent CLIs you already have (Codex, OpenCode, Claude Code, Pi, Hermes, Gemini,
Aider, Goose) as **agents** you can spawn, watch, steer and stop — live, in a 3D office in the browser
or from the terminal. Agents get roles (CEO, coordinator, worker), share a memory, work on a task
board, and get their own git worktree so two workers never fight over the same files.

Everything runs on your machine. The server listens on `127.0.0.1` only, keeps its data in
`~/.agentix`, and never calls a model API itself — the agent CLIs do that.

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
to the coordinator only, with a live digest of the whole team. You can coordinate by hand instead
(`human` mode), or let the coordinator route your instructions (`agent` mode), or both.

**Shared memory.** A team brief, notes any agent can save with `@@remember :: <fact>`, and BM25 (plus
optional local embeddings via Ollama) search over notes, past agent output and the folders you choose.
Agents get the best matches in front of every task.

**A task board** that moves on its own: `todo → doing → review` as agents work, `blocked` when a turn
fails.

**Git worktrees.** A worker inside a git repo gets its own branch and folder, so parallel agents never
overwrite each other. Diff, merge or discard from the dashboard.

**Permanent history.** Every event is in SQLite and in plain JSONL files under `~/.agentix/history/`.
Removing an agent archives it; its history stays searchable.

---

## CLI

```
agentix server                          Start the server (AGENTIX_PORT, default 4317)
agentix doctor                          Check node, store and installed agent CLIs
agentix spawn <kind> [opts] "<prompt>"  Spawn an agent
    --role worker|coordinator|ceo  --avatar 0-9|random  --name N  --cwd DIR
    --model M  --worktree|--no-worktree  --replace
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
packages/server   the server: REST + SSE API, agent sessions, worktrees, context search, tasks
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
and the folders to search, worktrees on/off, event retention, and optional local embeddings
(Ollama) for meaning search.

Environment variables:

| Variable | Meaning |
|---|---|
| `AGENTIX_PORT` | server port (default `4317`) |
| `AGENTIX_URL` | server URL the CLI talks to |
| `AGENTIX_HOME` | data directory (default `~/.agentix`) |
| `AGENTIX_WEB_DIST` | folder the dashboard is served from |
| `AGENTIX_STORE=json` | force the JSON store instead of SQLite |
| `AGENTIX_<KIND>_BIN` | path to one agent CLI (e.g. `AGENTIX_CODEX_BIN`) |
| `AGENTIX_UPDATE_DELAY_MS` | how long coordinator updates are batched (default 5000) |
| `AGENTIX_CEO_REPLY_TIMEOUT_MS` | how long the CEO waits for the coordinator (default 30000) |

---

## Security

The API answers only this machine: a `Host` other than `localhost`/`127.0.0.1` gets `403` (blocks
DNS rebinding), and so does any `/api` request with a foreign `Origin`. No CORS headers are sent,
so a web page you have open in the same browser cannot spawn or steer agents. The server binds to
the loopback interface only. Agent CLIs keep their own credentials; Agentix never stores them.

Data on disk (`~/.agentix`): the SQLite database, `context/` (brief, notes, embedding cache),
`history/` (JSONL event log), `worktrees/` and `tasks.json`.
