# Agentix Adapters

## Supported Agents

### mock
- **Status:** Fully implemented
- **Purpose:** Testing without external dependencies
- **Behavior:** Simulates a believable sequence of events over ~5 seconds

### codex
- **Status:** Implemented (needs internet to test)
- **Command:** `codex exec --json "<prompt>"`
- **Resume:** `codex exec resume <session-id> "<prompt>"`
- **Output:** JSONL events on stdout
- **Mapping:** item/message → output, command/patch → tool

### opencode
- **Status:** Implemented (needs `opencode --help` to verify flags)
- **Command:** `opencode run "<prompt>"`
- **Resume:** `opencode run --resume <session-id> "<prompt>"`
- **Note:** If `opencode serve` exposes an HTTP API with event stream, prefer that

### claude
- **Status:** Implemented (writing only — kenz loses access Oct 17)
- **Command:** `claude -p "<prompt>" --output-format stream-json --verbose`
- **Resume:** `--resume <session_id>`
- **Note:** Don't block on testing this

## Adding a New Adapter

1. Create `packages/server/src/adapters/<name>.ts`
2. Implement the `AgentAdapter` interface:
   ```ts
   interface AgentAdapter {
     kind: string;
     detect(): Promise<{ installed: boolean; version?: string }>;
     send(ctx: AdapterContext, prompt: string): Promise<void>;
     interrupt(ctx: AdapterContext): Promise<void>;
   }
   ```
3. Register in `packages/server/src/adapters/index.ts`
4. Add to `AgentKind` type in `packages/shared/src/types.ts`
5. Document in this file

No changes needed elsewhere — the server and CLI auto-discover adapters.
