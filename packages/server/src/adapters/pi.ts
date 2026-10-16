// Agentix — Pi coding agent adapter (@mariozechner/pi-coding-agent)
// Flags from `pi --help` (0.73.1):
//   pi -p --mode json [--session <id>] [--append-system-prompt <text>] <prompt>
// JSON lines (docs/json.md): {type:'session',id} header, tool_execution_start{toolName,args},
//   message_end{message:{role:'assistant',content:[{type:'text',text}],stopReason,errorMessage?,
//   usage?:{input,output,cacheRead,cacheWrite,totalTokens,cost:{total}}}}, agent_end.
// A turn can hold several assistant messages (one per model call); their usage is summed into one event.
// Pi exits 0 even when the model call fails, so an assistant message with stopReason "error" fails the turn.
import type { AgentAdapter, AdapterContext } from './types.ts';
import { detectCliWithHelp, runCli, parseJson, oneLine, UsageTally } from './proc.ts';

/** What the Pi coding agent's --help mentions; Debian's unrelated `pi` (digits of π) has none of it. */
export const PI_HELP_SIGNATURE = /--append-system-prompt|--mode\b/;

export function piArgs(prompt: string, sessionId?: string, instructions?: string): string[] {
  const args = ['-p', '--mode', 'json'];
  if (sessionId) args.push('--session', sessionId);
  if (instructions) args.push('--append-system-prompt', instructions);
  // A leading "-" would parse as a flag and a leading "@" as a file to attach.
  args.push(/^[-@]/.test(prompt) ? ' ' + prompt : prompt);
  return args;
}

/** `usage` adds up each assistant message's tokens; the caller emits the total once the turn ends. */
export function handlePiEvent(ctx: AdapterContext, ev: any, failures: string[], usage?: UsageTally): void {
  switch (ev.type) {
    case 'session':
      if (ev.id && ev.id !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(String(ev.id));
      break;
    case 'turn_start':
      ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: 'thinking…' } });
      break;
    case 'tool_execution_start': {
      const a = ev.args ?? {};
      const detail = a.command ?? a.path ?? a.file_path ?? a.pattern;
      const tool = `${ev.toolName}${detail ? `: ${oneLine(detail)}` : ''}`;
      ctx.emit({ type: 'tool', text: tool, data: ev });
      ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
      break;
    }
    case 'tool_execution_end':
      if (ev.isError) ctx.emit({ type: 'tool', text: `${ev.toolName} failed`, data: ev });
      break;
    case 'message_end': {
      const m = ev.message ?? {};
      if (m.role !== 'assistant') break;
      const text = (m.content ?? []).filter((c: any) => c.type === 'text' && c.text).map((c: any) => c.text).join('\n').trim();
      if (text) ctx.emit({ type: 'output', text });
      const u = m.usage;
      if (u) usage?.add({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total });
      if (m.stopReason === 'error') failures.push(String(m.errorMessage ?? 'pi: model call failed'));
      break;
    }
    case 'auto_retry_start':
      ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: `retrying (${ev.attempt}/${ev.maxAttempts})` } });
      break;
  }
}

export const piAdapter: AgentAdapter = {
  kind: 'pi',

  detect: () => detectCliWithHelp('pi', PI_HELP_SIGNATURE, 'the Pi coding agent'),

  async send(ctx, prompt) {
    const failures: string[] = [];
    const usage = new UsageTally();
    try {
      await runCli(ctx, 'pi', piArgs(prompt, ctx.agent.nativeSessionId, ctx.instructions), line => {
        const ev = parseJson(line);
        if (ev) handlePiEvent(ctx, ev, failures, usage);
      });
    } finally {
      usage.emit(ctx); // tokens spent before a failure still count
    }
    if (failures.length && !ctx.signal.aborted) throw new Error(failures.at(-1));
  },
};
