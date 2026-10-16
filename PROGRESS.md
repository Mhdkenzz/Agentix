# Agentix — Progress

## Step 1: Agent backend + CLI

### What's done
- ✅ Shared types (`packages/shared/src/types.ts`)
- ✅ Adapter interface (`packages/server/src/adapters/types.ts`)
- ✅ Mock adapter (`packages/server/src/adapters/mock.ts`)
- ✅ Codex adapter (`packages/server/src/adapters/codex.ts`)
- ✅ OpenCode adapter (`packages/server/src/adapters/opencode.ts`)
- ✅ Claude adapter (`packages/server/src/adapters/claude.ts`)
- ✅ Adapter registry (`packages/server/src/adapters/index.ts`)
- ✅ SQLite/JSON store (`packages/server/src/store.ts`)
- ✅ Event bus (`packages/server/src/bus.ts`)
- ✅ Session manager (`packages/server/src/sessions.ts`)
- ✅ HTTP server with REST + SSE (`packages/server/src/index.ts`)
- ✅ CLI (`packages/cli/src/agentix.ts`)
- ✅ Tests (`packages/server/test/run.test.ts`)
- ✅ Documentation (`docs/api.md`, `docs/adapters.md`)
- ✅ Package.json files (monorepo with workspaces)

### Acceptance checks
1. ✅ `agentix doctor` — prints Node version, store type (json), and installed agent CLIs
2. ✅ `agentix server` — starts on 127.0.0.1:4317
3. ✅ `agentix spawn mock "hello"` — creates agent; `agentix ls` shows status `thinking → working → idle`
4. ✅ `agentix watch` — live feed works (SSE-based)
5. ✅ `agentix steer <id> "change of plan"` — interrupts and starts new turn; steer event logged
6. ✅ Three mock agents run concurrently without interference
7. ✅ Server restart: agents and event history persist (JSON store)
8. ✅ `curl -N http://127.0.0.1:4317/api/stream` — shows SSE events with IDs
9. ✅ `node --test` passes (8/8 tests)
10. ⏳ Codex real agent — **pending (needs internet to test)**

### Known issues
- **No npm installed** — the bundled node at `/usr/lib/chatgpt/resources/cua_node/bin/node` doesn't include npm
- **No internet** — can't install npm or fetch packages
- Tests use `node:test` with `--experimental-strip-types` (Node 24)
- The CLI uses `globalThis.fetch` (available in Node 24)
- Parameter properties (`constructor(private x: Y)`) not supported by strip-types — fixed by using explicit field assignment

### Next steps
- Step 2: Live 3D office dashboard (needs npm install — blocked by no npm/internet)
- When internet is available: install npm, build the web frontend
- Test with real Codex agent
