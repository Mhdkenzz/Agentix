// Agentix — OpenCode CLI adapter
// Verified against opencode v2.0.30 (`opencode run --help`):
//   opencode run --standalone --format json --auto [-s <sessionID>] <message>
// --standalone: without it, `run` attaches to opencode's shared background service, which works in
//   *that service's* directory and ignores our cwd (seen live: files landed in the wrong folder).
// --auto approves permissions that aren't explicitly denied (no one is there to answer prompts).
// JSON lines carry sessionID and a `part`: step_start, text{part.text}, tool_use{part.tool, part.state},
//   step_finish{part.reason, part.tokens:{input,output,reasoning,cache:{read,write}}, part.cost}, error{error}
// Each step_finish carries that step's tokens; the turn's sum goes out as one usage event at the end.
import { withInstructions, type AgentAdapter, type AdapterContext } from './types.ts';
import { detectCli, runCli, parseJson, oneLine, count, UsageTally } from './proc.ts';

export function opencodeArgs(prompt: string, sessionId?: string): string[] {
  const args = ['run', '--standalone', '--format', 'json', '--auto'];
  if (sessionId) args.push('-s', sessionId);
  // `--` only when needed: a prompt starting with "-" would otherwise parse as a flag
  if (prompt.startsWith('-')) args.push('--');
  args.push(prompt);
  return args;
}

/** `usage` adds up each step's tokens; the caller emits the total once the turn ends. */
export function handleOpencodeEvent(ctx: AdapterContext, ev: any, usage?: UsageTally): void {
  if (ev.sessionID && ev.sessionID !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(String(ev.sessionID));
  const part = ev.part ?? {};

  switch (ev.type) {
    case 'text':
      if (part.text) ctx.emit({ type: 'output', text: String(part.text) });
      return;
    case 'reasoning':
      ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: oneLine(part.text || 'thinking…') } });
      if (part.text) ctx.emit({ type: 'thinking', text: String(part.text) });
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
    case 'step_finish': {
      const t = part.tokens ?? {};
      // reasoning tokens are billed as output
      usage?.add({ input: t.input, output: count(t.output) + count(t.reasoning), cacheRead: t.cache?.read, cacheWrite: t.cache?.write, cost: part.cost });
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
    const usage = new UsageTally();
    try {
      await runCli(ctx, 'opencode', opencodeArgs(withInstructions(ctx, prompt), ctx.agent.nativeSessionId), line => {
        const ev = parseJson(line);
        if (ev) handleOpencodeEvent(ctx, ev, usage);
        else ctx.emit({ type: 'output', text: line });
      });
    } finally {
      usage.emit(ctx); // tokens spent before a failure still count
    }
  },
};
