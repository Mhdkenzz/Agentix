// Agentix — OpenCode CLI adapter
// Verified against opencode v2.0.30 (`opencode run --help`):
//   opencode run --standalone --format json --auto [-s <sessionID>] <message>
// --standalone: without it, `run` attaches to opencode's shared background service, which works in
//   *that service's* directory and ignores our cwd (seen live: files landed in the wrong folder).
// --auto approves permissions that aren't explicitly denied (no one is there to answer prompts).
// JSON lines carry sessionID and a `part`: step_start, text{part.text}, tool_use{part.tool, part.state},
//   step_finish{part.reason}, error{error}
import type { AgentAdapter, AdapterContext } from './types.ts';
import { detectCli, runCli, parseJson, oneLine } from './proc.ts';

export function opencodeArgs(prompt: string, sessionId?: string): string[] {
  const args = ['run', '--standalone', '--format', 'json', '--auto'];
  if (sessionId) args.push('-s', sessionId);
  // `--` only when needed: a prompt starting with "-" would otherwise parse as a flag
  if (prompt.startsWith('-')) args.push('--');
  args.push(prompt);
  return args;
}

export function handleOpencodeEvent(ctx: AdapterContext, ev: any): void {
  if (ev.sessionID && ev.sessionID !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(String(ev.sessionID));
  const part = ev.part ?? {};

  switch (ev.type) {
    case 'text':
      if (part.text) ctx.emit({ type: 'output', text: String(part.text) });
      return;
    case 'reasoning':
      ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: oneLine(part.text || 'thinking…') } });
      return;
    case 'tool_use': {
      const input = part.state?.input ?? {};
      const detail = input.command ?? input.filePath ?? input.path ?? input.pattern ?? '';
      const tool = `${part.tool ?? 'tool'}${detail ? `: ${oneLine(detail)}` : ''}`;
      ctx.emit({ type: 'tool', text: tool, data: part });
      ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
      if (part.state?.status === 'error') ctx.emit({ type: 'error', text: `${tool} failed: ${oneLine(part.state.error, 200)}` });
      return;
    }
    case 'error': {
      const err = ev.error ?? {};
      ctx.emit({ type: 'error', text: String(err.data?.message ?? err.message ?? err.name ?? 'opencode error'), data: ev });
      return;
    }
  }
}

export const opencodeAdapter: AgentAdapter = {
  kind: 'opencode',

  detect: () => detectCli('opencode'),

  async send(ctx, prompt) {
    await runCli(ctx, 'opencode', opencodeArgs(prompt, ctx.agent.nativeSessionId), line => {
      const ev = parseJson(line);
      if (ev) handleOpencodeEvent(ctx, ev);
      else ctx.emit({ type: 'output', text: line });
    });
  },
};
