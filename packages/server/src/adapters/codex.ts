// Agentix — Codex CLI adapter
// Verified against codex-cli 0.162.1 (`codex exec --help`, `codex exec resume --help`):
//   new:    codex exec --json --skip-git-repo-check -s workspace-write -C <cwd> -- <prompt>
//   resume: codex exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" -- <id> <prompt>
//           (resume has no -s/-C, so the sandbox goes through -c and the cwd is the process cwd)
// JSONL events: thread.started{thread_id}, turn.started, item.started/item.completed{item},
//   turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens}} → one usage event,
//   turn.failed{error}, error{message}
import { withInstructions, type AgentAdapter, type AdapterContext } from './types.ts';
import { detectCli, runCli, parseJson, oneLine, emitUsage } from './proc.ts';

const SANDBOX = process.env.AGENTIX_CODEX_SANDBOX || 'workspace-write';

export function codexArgs(cwd: string, prompt: string, sessionId?: string, model?: string): string[] {
  // -c works for both exec and exec resume (resume has no -m). "<model>:<effort>" also sets the reasoning level.
  const [name, effort] = (model ?? '').split(':');
  const m = [...(name ? ['-c', `model="${name}"`] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];
  return sessionId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${SANDBOX}"`, ...m, '--', sessionId, prompt]
    : ['exec', '--json', '--skip-git-repo-check', '-s', SANDBOX, '-C', cwd, ...m, '--', prompt];
}

export function handleCodexEvent(ctx: AdapterContext, ev: any): void {
  switch (ev.type) {
    case 'thread.started':
      if (ev.thread_id) ctx.setNativeSessionId(String(ev.thread_id));
      return;
    case 'item.started':
    case 'item.completed': {
      const item = ev.item ?? {};
      const done = ev.type === 'item.completed';
      switch (item.type) {
        case 'agent_message':
          if (done && item.text) ctx.emit({ type: 'output', text: String(item.text), data: item });
          return;
        case 'reasoning':
          ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: oneLine(item.text || 'thinking…') } });
          if (done && item.text) ctx.emit({ type: 'thinking', text: String(item.text) });
          return;
        case 'command_execution':
          if (!done) {
            const tool = `$ ${oneLine(item.command)}`;
            ctx.emit({ type: 'tool', text: tool, data: item });
            ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
          }
          return;
        case 'file_change':
          if (done) {
            const files = (item.changes ?? []).map((c: any) => `${c.kind ?? 'edit'} ${c.path}`).join(', ');
            const tool = `files: ${oneLine(files)}`;
            ctx.emit({ type: 'tool', text: tool, data: item });
            ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
          }
          return;
        case 'mcp_tool_call':
        case 'web_search':
          if (!done) {
            const tool = item.type === 'web_search' ? `search: ${oneLine(item.query)}` : `mcp: ${item.server ?? ''}.${item.tool ?? ''}`;
            ctx.emit({ type: 'tool', text: tool, data: item });
            ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
          }
          return;
        case 'error':
          if (done) ctx.emit({ type: 'error', text: String(item.message ?? 'codex error'), data: item });
          return;
      }
      return;
    }
    case 'turn.completed': {
      // input_tokens includes the cached part, as in the OpenAI API
      const u = ev.usage ?? {};
      emitUsage(ctx, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cached_input_tokens });
      return;
    }
    case 'turn.failed':
      ctx.emit({ type: 'error', text: String(ev.error?.message ?? 'turn failed'), data: ev });
      return;
    case 'error':
      ctx.emit({ type: 'error', text: String(ev.message ?? 'codex error'), data: ev });
      return;
  }
}

export const codexAdapter: AgentAdapter = {
  kind: 'codex',

  detect: () => detectCli('codex'),

  async send(ctx, prompt) {
    await runCli(ctx, 'codex', codexArgs(ctx.agent.cwd, withInstructions(ctx, prompt), ctx.agent.nativeSessionId, ctx.agent.model), line => {
      const ev = parseJson(line);
      if (ev) handleCodexEvent(ctx, ev);
      else ctx.emit({ type: 'output', text: line });
    });
  },
};
