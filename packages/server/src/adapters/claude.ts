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

/** What Claude Code prints, as its whole reply, when it has no usable credentials. */
const NOT_SIGNED_IN = /^(not logged in|invalid api key)\b.*\/login/i;
export const CLAUDE_SIGN_IN_HELP =
  "Claude Code isn't signed in on this computer. Open a terminal and run `claude auth login` (or run `claude` and type /login), then send your message again.";

/** Turns one stream-json line into events. Returns true when Claude Code says it isn't signed in. */
export function handleClaudeEvent(ctx: AdapterContext, ev: any): boolean {
  if (ev.session_id && ev.session_id !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(String(ev.session_id));

  if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text) {
        if (NOT_SIGNED_IN.test(String(block.text).trim())) return true;
        ctx.emit({ type: 'output', text: String(block.text) });
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        const tool = `${block.name}${input.command ? `: ${oneLine(input.command)}` : input.file_path ? `: ${input.file_path}` : ''}`;
        ctx.emit({ type: 'tool', text: tool, data: block });
        ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
      } else if (block.type === 'thinking') {
        ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: 'thinking…' } });
        if (block.thinking) ctx.emit({ type: 'thinking', text: String(block.thinking) });
      }
    }
  } else if (ev.type === 'result' && ev.is_error) {
    if (NOT_SIGNED_IN.test(String(ev.result ?? '').trim())) return true;
    ctx.emit({ type: 'error', text: String(ev.result ?? 'claude error'), data: ev });
  }
  return false;
}

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',

  detect: () => detectCli('claude'),

  async send(ctx, prompt) {
    let notSignedIn = false;
    try {
      await runCli(ctx, 'claude', claudeArgs(withInstructions(ctx, prompt), ctx.agent.nativeSessionId), line => {
        const ev = parseJson(line);
        if (!ev) ctx.emit({ type: 'output', text: line });
        else if (handleClaudeEvent(ctx, ev)) notSignedIn = true;
      });
    } catch (err) {
      if (!notSignedIn) throw err;
    }
    // One clear error instead of the CLI's reply, its error result and the exit code.
    if (notSignedIn) throw new Error(CLAUDE_SIGN_IN_HELP);
  },
};
