# Agentix — Plan and Build Prompt for OpenCode

This file has three parts:

1. **Vision**: what kenz wants, in their own words.
2. **The 4-step plan.**
3. **The build prompt**: paste everything from "PART 3" down into OpenCode, or tell OpenCode: *"Read AGENTIX_PLAN.md and follow PART 3, starting at Step 1."*

---

## PART 1 — Vision (kenz's requirements, verbatim)

> It's a web dashboard and cli, it's both. I have Claude code only til October 17 tho, I hav codex and opencode, gona install more soon. First win would be a web dashboard like a web game basically. In the web dashboard I want to see live what each agent is doing and I can spawn as many sessions as I want. I can spawn one as the coordinator or I can coordinate both. I want avatars for every agent, 10 pre made avatars and I can choose or set it to random while making new agent, and I Wana see them live on dashboard. Dashboard is gona be few pages. Main page a office, a 3d office with desks. The coordinator gets a private office, rest get cubicles or desks on sides of the main room, and I can click on each avatar and see what theyr doing live and steer or direct them and coordinator knows immediately. And I Want a top dawg agent like CEO which I can hav live conversations with speaking to it. It should speak to the coordinator only but stil has context of what all the other agents are doing.

**Supported agents now:** Codex CLI, OpenCode CLI, Claude Code CLI (until Oct 17). **Later:** Hermes, Pi agent, others.

---

## PART 2 — The 4-step plan

1. **Agent backend and CLI.** A small local server that can spawn, stream and steer Claude Code, Codex and OpenCode sessions through one common interface. It stores each agent's role (CEO, coordinator or worker) and avatar. The `agentix` CLI talks to that server.
2. **Live office dashboard.** A 3D office in the browser: the coordinator's private office, desks/cubicles around the main room, and 10 premade avatars (pick one or randomize). Each avatar shows what its agent is doing live. Click one to see its output and steer it; the coordinator is notified right away.
3. **Coordinator and CEO.** A coordinator mode so kenz can coordinate personally or hand it to an agent. Then a CEO kenz can talk to by voice. The CEO only messages the coordinator, but gets a live summary of every agent.
4. **More pages and agents.** Agents list, session history and settings pages, plus adapters for Hermes, Pi and others.

---

## PART 3 — Build prompt for OpenCode

> **You are building Agentix**, a local app for creating, watching and steering AI coding agents (Codex, OpenCode, Claude Code, later Hermes/Pi) from one web dashboard and one CLI. Work through the steps below **in order, starting with Step 1**. Finish each step's acceptance checks before moving to the next. Commit to git after each step with a clear message. Keep a running `PROGRESS.md` at the repo root noting what's done, what's broken and what you'd do next, so kenz can catch up when back online.

### 3.0 Ground rules (read first)

**Internet.** This machine may be offline while you work.
- `npm install` / `pnpm install` **need internet** unless packages are already in the local npm cache. Try `npm install --prefer-offline` first; if it fails, don't loop on it. Write the code anyway, note the missing install in `PROGRESS.md`, and move on to work that doesn't need it.
- That's why **Step 1 uses zero npm dependencies** (Node built-ins only), so it can be built and tested fully offline.
- Real agents (Codex, Claude Code) need internet to call their models. Use the **`mock` adapter** (defined below) to test everything offline. When online, the first real test agent is **Codex**. Don't depend on Claude Code; kenz loses access on Oct 17.
- Never invent CLI flags. Before writing each adapter, run `<cli> --help` (and subcommand help, e.g. `codex exec --help`, `opencode run --help`, `claude --help`) and code against what the installed version actually says. Record the version and the flags you used in `docs/adapters.md`.

**Tech stack (defaults, use these):**
| Part | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | one language, shared types |
| Runtime | Node.js ≥ 22.6 (check `node -v`) | built-in `node:sqlite`, `--experimental-strip-types` runs `.ts` without a build step |
| Backend (Step 1) | `node:http` + `node:child_process` + `node:sqlite`, no npm deps | works offline |
| Live updates | Server-Sent Events (SSE) for server→browser/CLI, plain JSON `POST` for commands | no WebSocket library needed; upgrade to `ws` later only if needed |
| Storage | SQLite file at `~/.agentix/agentix.db` | if `node:sqlite` is missing, fall back to a JSON file store behind the same interface |
| Frontend (Step 2) | Vite + React + three.js via `@react-three/fiber` + `@react-three/drei`, Zustand for state | needs `npm install` (internet) |
| CLI | plain Node script, `node:util` `parseArgs` | no deps |
| Voice (Step 3) | browser Web Speech API (`SpeechRecognition` + `speechSynthesis`) | no deps; Chrome/Edge |

If the Node version is too old for `node:sqlite` or strip-types, say so in `PROGRESS.md`, use the JSON store, and compile with `tsc` if it's installed (or write plain `.mjs` with JSDoc types as a last resort).

**Folder structure (monorepo, npm workspaces):**
```
agentix/
  package.json              # workspaces: ["packages/*"]
  PROGRESS.md
  docs/
    adapters.md             # verified CLI flags per agent
    api.md                  # REST + SSE reference
  packages/
    shared/                 # types used by server, cli, web
      src/types.ts
    server/
      src/index.ts          # http server, routes
      src/store.ts          # sqlite / json store
      src/bus.ts            # in-process event bus -> SSE fan-out
      src/sessions.ts       # session manager (spawn, steer, stop, restart)
      src/adapters/
        types.ts            # AgentAdapter interface
        mock.ts
        codex.ts
        opencode.ts
        claude.ts
        index.ts            # registry: name -> adapter
      test/                 # node:test tests
    cli/
      src/agentix.ts        # `agentix` command
    web/                    # Step 2 (Vite React app)
      src/
        pages/Office.tsx
        pages/Agents.tsx    # Step 4
        pages/History.tsx   # Step 4
        pages/Settings.tsx  # Step 4
        office/             # 3D scene pieces
        avatars/            # 10 avatar definitions
        api.ts              # REST + SSE client
```

### 3.1 Shared data model (`packages/shared/src/types.ts`)

```ts
export type AgentKind = 'mock' | 'codex' | 'opencode' | 'claude' | 'hermes' | 'pi';
export type Role = 'ceo' | 'coordinator' | 'worker';
export type Status = 'starting' | 'idle' | 'thinking' | 'working' | 'waiting_input' | 'error' | 'stopped';

export interface Agent {
  id: string;            // short id, e.g. "a_7k2x"
  name: string;          // "Nova"
  kind: AgentKind;
  role: Role;
  avatarId: number;      // 0..9
  cwd: string;           // working directory the agent runs in
  status: Status;
  activity: string;      // one-line "what it's doing now", e.g. "editing src/app.ts"
  nativeSessionId?: string; // the CLI's own session/thread id, for resume
  createdAt: number;
}

export type EventType =
  | 'agent.created' | 'agent.updated' | 'agent.removed'
  | 'output'        // text the agent produced
  | 'tool'          // agent ran a command / edited a file
  | 'status'        // status/activity change
  | 'steer'         // a human or agent sent instructions
  | 'message'       // agent-to-agent message (CEO -> coordinator, coordinator -> worker)
  | 'error';

export interface AgentEvent {
  id: number;            // monotonic, from the store
  agentId: string;
  type: EventType;
  ts: number;
  from?: string;         // 'user' | agentId
  text?: string;
  data?: unknown;        // raw adapter payload, for the detail view
}
```

Rules: **only one coordinator and one CEO at a time** (creating a second asks to demote the first). Workers are unlimited.

### 3.2 Adapter interface (`packages/server/src/adapters/types.ts`)

```ts
export interface AdapterContext {
  agent: Agent;
  emit(e: Omit<AgentEvent, 'id' | 'ts' | 'agentId'>): void; // push normalized events
  setNativeSessionId(id: string): void;
}

export interface AgentAdapter {
  kind: AgentKind;
  /** true if the CLI is installed (e.g. `which codex`), plus its version */
  detect(): Promise<{ installed: boolean; version?: string }>;
  /** run one turn: start a new session or continue the existing one */
  send(ctx: AdapterContext, prompt: string): Promise<void>;
  /** stop the current turn (SIGINT, then SIGTERM after 3s) */
  interrupt(ctx: AdapterContext): Promise<void>;
}
```

**Turn-based model.** Each `send` spawns the CLI in non-interactive mode with JSON/streaming output, parses each output line into `AgentEvent`s, and saves the CLI's native session id so the next `send` **resumes the same conversation**. "Steering" = interrupt the current turn if busy, then `send` the new instruction with resume. That works the same way for every CLI and needs no terminal emulation.

Adapters to write (confirm every flag with `--help` first, these are starting points, not facts):
- **mock**: no external process. On `send`, emits a believable sequence over ~5 s (`thinking` → a few `tool` events like "reading README.md" → `output` → `idle`). Used for all offline tests and UI work.
- **codex**: `codex exec --json "<prompt>"` in `cwd` (JSONL events on stdout); resume with `codex exec resume <session-id> "<prompt>"` or whatever `codex exec --help` shows. Map item/message events to `output`, command/patch events to `tool`. **First real agent to test.**
- **opencode**: `opencode run "<prompt>"` with its JSON output format flag if it has one; continue with its session/continue flag. Alternatively, `opencode serve` exposes an HTTP API with an event stream; if `--help` shows it, prefer that for richer events. Document which you chose.
- **claude**: `claude -p "<prompt>" --output-format stream-json --verbose`, resume with `--resume <session_id>` (the id comes in the first `system`/`init` event). Optional, since access ends Oct 17. Write it but don't block on testing it.

Each adapter must also derive the one-line `activity` string (e.g. `"running npm test"`, `"editing src/x.ts"`, `"thinking"`), because the 3D office shows it above each avatar.

### 3.3 Server API (`docs/api.md`)

Default port **4317**, bind to `127.0.0.1` only.

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/adapters` | which CLIs are installed + versions |
| GET | `/api/agents` | list |
| POST | `/api/agents` | `{name?, kind, role, avatarId? \| "random", cwd, prompt?}` → creates; if `prompt`, starts first turn |
| PATCH | `/api/agents/:id` | rename, change avatar/role |
| DELETE | `/api/agents/:id` | stop + remove |
| POST | `/api/agents/:id/steer` | `{text, from?}` → interrupt if busy, then send; **also emits a `steer` event that the coordinator receives** (see 3.6) |
| POST | `/api/agents/:id/interrupt` | stop current turn |
| GET | `/api/agents/:id/events?after=N` | history |
| GET | `/api/stream` | **SSE**, all events for all agents; supports `Last-Event-ID` to resume |
| GET | `/api/agents/:id/stream` | SSE for one agent |
| GET | `/` | serves the built web app from `packages/web/dist` (Step 2) |

Names: if none given, pick from a built-in list (Nova, Atlas, Echo, Pixel, Rook, Juno, Sable, Orbit, Vex, Kai, ...).

### 3.4 CLI (`agentix`)

Add a `bin` entry so `npm link` gives an `agentix` command.
```
agentix server                         # start the server (foreground)
agentix doctor                         # node version, sqlite, which agent CLIs exist
agentix spawn codex --role worker --avatar random --cwd . "fix the failing test"
agentix ls                             # table: id, name, kind, role, status, activity
agentix logs <id> [-f]                 # print / follow events
agentix steer <id> "use pnpm instead"
agentix stop <id>
agentix rm <id>
agentix watch                          # live feed of all agents, one line per event, coloured by agent
```
The CLI only talks to the server over HTTP/SSE; it never spawns agents itself.

---

### STEP 1 — Agent backend + CLI (zero dependencies, fully offline)

Build: `shared`, `server` (store, bus, session manager, `mock` + `codex` + `opencode` + `claude` adapters), `cli`. Write tests with `node:test`.

**Acceptance checks (all must pass offline):**
1. `agentix doctor` prints Node version, store type (sqlite/json) and installed agent CLIs with versions.
2. `agentix server` starts on 127.0.0.1:4317.
3. `agentix spawn mock "hello"` creates an agent; `agentix ls` shows it with status changing `thinking → working → idle`.
4. `agentix watch` in a second terminal shows live events while a mock agent runs.
5. `agentix steer <id> "change of plan"` while the mock is mid-turn interrupts it, starts a new turn, and the event log shows the `steer` event.
6. Three mock agents run at once without interfering.
7. Restart the server: agents and event history are still there (status reset to `idle`/`stopped`).
8. `curl -N http://127.0.0.1:4317/api/stream` shows SSE events.
9. `node --test` passes.
10. **When online:** `agentix spawn codex --cwd /tmp/agentix-test "create hello.txt containing hi"` works end to end, live output streams, and a follow-up `steer` resumes the same Codex session. Record the result in `PROGRESS.md`.

### STEP 2 — Live 3D office dashboard (needs `npm install`)

Create `packages/web` with Vite + React + TypeScript + `three` + `@react-three/fiber` + `@react-three/drei` + `zustand` + `react-router-dom`. If install fails offline, write the code anyway and note it.

**Office scene (`pages/Office.tsx`, the main page):**
- Low-poly, game-like room viewed from an angled top-down camera (`OrbitControls`, limited zoom/tilt). Simple shapes only (boxes, cylinders), no external model files required, so it works offline.
- **Private office** for the coordinator: a glass-walled room on one side with its own desk and door.
- **Main room**: rows of desks/cubicles along the side walls for workers. Desks are assigned automatically in order; add more rows when there are more agents than desks.
- **CEO**: a separate corner office or raised platform, visually distinct (Step 3 fills in behaviour, but reserve the spot now).
- Each agent = its avatar sitting at its desk, with a floating name tag and a speech-bubble showing its live `activity` text. Animate by status: `thinking` = bobbing + "…" bubble, `working` = typing motion + monitor glow, `idle` = still, `error` = red pulse, `waiting_input` = raised hand / "?" bubble.
- When one agent sends a `message` to another, draw a short animated arc or paper-plane between their desks.

**10 premade avatars (`avatars/index.ts`):** define them in code as simple stylised characters built from primitives (head, body, hair/hat, accessory), each with a name, colour palette and one distinct feature, e.g. 0 Robot, 1 Astronaut, 2 Wizard, 3 Ninja, 4 Cat-person, 5 Hacker in hoodie, 6 Scientist, 7 Pirate, 8 Knight, 9 Alien. Also render a 2D thumbnail (small canvas render or SVG) for pickers.

**UI on top of the 3D scene (HTML overlay):**
- Top bar: page links (Office, Agents, History, Settings), count of agents by status, "+ New agent" button.
- **New agent modal**: name (optional, random default), agent kind (only installed ones enabled, from `/api/adapters`), role (worker/coordinator/CEO), working directory, first prompt, avatar picker showing all 10 thumbnails **plus a "Random" option**.
- **Click an avatar** → side panel: live event stream (output, tool calls, steers), status, a text box to **steer** (Enter sends), Interrupt and Stop buttons. Steering calls `POST /steer`, so the coordinator is informed automatically (see Step 3).
- Live updates via one `EventSource('/api/stream')`, reconnecting with `Last-Event-ID`.

**Acceptance checks:**
1. `npm run dev` in `packages/web` (proxying `/api` to 4317) shows the office; `npm run build` output is served by the server at `/`.
2. Spawning 5 mock agents from the UI puts 5 avatars at desks, each animating and showing live activity text.
3. Choosing "Random" picks an avatar; choosing a specific one uses it.
4. A coordinator appears in the private office.
5. Clicking an avatar opens its live panel; steering from the panel changes its next output within a second or two.
6. Works at 60 fps-ish with 15 mock agents on a normal laptop (reduce shadows/geometry if not).

### STEP 3 — Coordinator and CEO

**Coordinator modes** (toggle in Settings and the top bar):
- **Human coordinator**: kenz coordinates; no coordinator agent needed.
- **Agent coordinator**: one agent with `role: 'coordinator'`.
- **Both**: an agent coordinator exists and kenz can also steer anyone directly.

**How the coordinator stays informed:** the server keeps a rolling **team digest**: per agent, its name, role, status, current activity, and its last ~3 outputs trimmed to a few lines. When anything important happens (a human steers a worker, a worker finishes or errors, a worker asks for input), the server sends the coordinator a turn that starts with `[AGENTIX UPDATE]` plus the event and the current digest. Batch updates that arrive within ~5 s into one turn so the coordinator isn't flooded. A human steer of any worker **must** reach the coordinator this way ("coordinator knows immediately").

**Coordinator → worker commands:** give the coordinator a system prompt explaining it can direct workers by writing lines like
```
@@spawn kind=codex name=Rook avatar=random cwd=/path :: <task>
@@steer <agentId or name> :: <instructions>
@@stop <agentId or name>
```
The server parses these lines from the coordinator's output and executes them (show each as a `message` event + paper-plane animation). Same mechanism lets the CEO talk to the coordinator.

**CEO:**
- One agent with `role: 'ceo'`. It may **only** message the coordinator (`@@tell coordinator :: <text>`); the server rejects any other target from the CEO.
- Each CEO turn is prefixed with the current team digest, so it always knows what every agent is doing.
- **Voice chat page/panel**: push-to-talk (hold Space or a mic button) using `webkitSpeechRecognition`; the transcript is sent to the CEO; the CEO's reply is read aloud with `speechSynthesis` and shown as text. Show a clear note that voice needs Chrome/Edge and (for recognition) usually internet. Text input works as fallback.

**Acceptance checks:**
1. Steering a worker from the UI causes the coordinator (mock is fine) to receive an `[AGENTIX UPDATE]` turn within ~5 s.
2. A coordinator output containing `@@spawn ...` creates a new worker at a desk; `@@steer` steers it.
3. The CEO answering "tell the coordinator to start the tests" produces a `message` from CEO to coordinator, and nothing from CEO to any worker.
4. Voice: speaking to the CEO in Chrome gives a spoken reply.

### STEP 4 — More pages and agents

- **Agents page**: table of all agents (filter by role/kind/status), bulk stop, edit avatar/name/role.
- **History page**: past sessions and full event logs, searchable, with "resume" (spawn a new turn on the same native session).
- **Settings page**: coordinator mode, default agent kind, default working directory, port, voice on/off, and per-adapter CLI path overrides.
- **New adapters**: Hermes and Pi agent (and others kenz installs). Each new adapter is just a new file in `adapters/` implementing `AgentAdapter`, registered in `adapters/index.ts`, plus a section in `docs/adapters.md`. Verify flags with `--help` as before.

**Acceptance checks:** each page loads with live data; adding a new adapter needs no changes outside `adapters/` and the `AgentKind` type.

---

### 3.5 Things not to do
- Don't bind the server to `0.0.0.0` (it can run commands on this machine).
- Don't let agents run outside their `cwd` by default; let kenz choose the directory per agent.
- Don't add a login system, cloud deploy, or Docker until kenz asks.
- Don't block on Claude Code; Codex is the primary real agent.
- Don't spend long fighting a failed `npm install` offline; note it in `PROGRESS.md` and continue with code.

### 3.6 When you're done with a step
1. Run its acceptance checks and write the results (pass/fail + notes) in `PROGRESS.md`.
2. `git commit` with message `step N: <summary>`.
3. Move to the next step.
