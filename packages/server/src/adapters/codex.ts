// Agentix — Codex CLI adapter
// Verified against codex-cli 0.162.1 (`codex exec --help`, `codex exec resume --help`):
//   new:    codex exec --json --skip-git-repo-check -s workspace-write -C <cwd> -- <prompt>
//   resume: codex exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" -- <id> <prompt>
//           (resume has no -s/-C, so the sandbox goes through -c and the cwd is the process cwd)
// JSONL events: thread.started{thread_id}, turn.started, item.started/item.completed{item},
//   turn.completed{usage}, turn.failed{error}, error{message}
import type { AgentAdapter, AdapterContext } from './types.ts';
import { detectCli, runCli, parseJson, oneLine } from './proc.ts';

const SANDBOX = process.env.AGENTIX_CODEX_SANDBOX || 'workspace-write';

export function codexArgs(cwd: string, prompt: string, sessionId?: string): string[] {
  return sessionId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${SANDBOX}"`, '--', sessionId, prompt]
    : ['exec', '--json', '--skip-git-repo-check', '-s', SANDBOX, '-C', cwd, '--', prompt];
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
    await runCli(ctx, 'codex', codexArgs(ctx.agent.cwd, prompt, ctx.agent.nativeSessionId), line => {
      const ev = parseJson(line);
      if (ev) handleCodexEvent(ctx, ev);
      else ctx.emit({ type: 'output', text: line });
    });
  },
};
