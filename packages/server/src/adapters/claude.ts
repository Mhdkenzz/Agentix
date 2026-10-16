// Agentix — Claude Code CLI adapter
// kenz loses Claude Code access on 2026-10-17; this is kept for later, tested only with a fake CLI.
// Flags from `claude --help`:
//   claude -p --output-format stream-json --verbose --permission-mode acceptEdits [--resume <id>] -- <prompt>
// stream-json lines: {type:'system',subtype:'init',session_id}, {type:'assistant',message:{content:[...]}},
//   {type:'result',is_error,result,session_id}
import { withInstructions, type AgentAdapter, type AdapterContext } from './types.ts';
import { detectCli, runCli, parseJson, oneLine } from './proc.ts';

export function claudeArgs(prompt: string, sessionId?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
  if (sessionId) args.push('--resume', sessionId);
  args.push('--', prompt);
  return args;
}

export function handleClaudeEvent(ctx: AdapterContext, ev: any): void {
  if (ev.session_id && ev.session_id !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(String(ev.session_id));

  if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text) {
        ctx.emit({ type: 'output', text: String(block.text) });
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        const tool = `${block.name}${input.command ? `: ${oneLine(input.command)}` : input.file_path ? `: ${input.file_path}` : ''}`;
        ctx.emit({ type: 'tool', text: tool, data: block });
        ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
      } else if (block.type === 'thinking') {
        ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: 'thinking…' } });
      }
    }
  } else if (ev.type === 'result' && ev.is_error) {
    ctx.emit({ type: 'error', text: String(ev.result ?? 'claude error'), data: ev });
  }
}

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',

  detect: () => detectCli('claude'),

  async send(ctx, prompt) {
    await runCli(ctx, 'claude', claudeArgs(withInstructions(ctx, prompt), ctx.agent.nativeSessionId), line => {
      const ev = parseJson(line);
      if (ev) handleClaudeEvent(ctx, ev);
      else ctx.emit({ type: 'output', text: line });
    });
  },
};
