// Agentix — Hermes Agent adapter (Nous Research, `pip install hermes-agent`)
// Flags from `hermes chat --help` (v0.19.0):
//   hermes chat -Q --query=<prompt> --source tool --yolo [--resume <session_id>]
// -Q prints only the final response on stdout; the session id goes to stderr as "session_id: <id>".
// Hermes has no streaming JSON mode in `chat`, so there are no live tool events: the answer arrives at the end.
// --yolo: nobody is there to answer approval prompts. --source tool keeps these runs out of kenz's own session list.
import { withInstructions, type AgentAdapter } from './types.ts';
import { detectCli, runCli } from './proc.ts';

export function hermesArgs(prompt: string, sessionId?: string, model?: string): string[] {
  const args = ['chat', '-Q', `--query=${prompt}`, '--source', 'tool', '--yolo'];
  if (model) args.push('-m', model);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

const SESSION_LINE = /^session_id:\s*(\S+)/;
// Startup notices Hermes prints to stdout even in quiet mode, e.g. "  ⚠ tirith security scanner ..."
const NOTICE = /^\s*⚠/;

export const hermesAdapter: AgentAdapter = {
  kind: 'hermes',

  detect: () => detectCli('hermes'),

  async send(ctx, prompt) {
    ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: 'working (Hermes reports when done)' } });
    const lines: string[] = [];
    try {
      await runCli(ctx, 'hermes', hermesArgs(withInstructions(ctx, prompt), ctx.agent.nativeSessionId, ctx.agent.model), line => {
        if (NOTICE.test(line)) return;
        lines.push(line);
      }, line => {
        const m = SESSION_LINE.exec(line.trim());
        if (m && m[1] !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(m[1]);
      });
    } finally {
      const text = lines.join('\n').trim();
      if (text && !ctx.signal.aborted) ctx.emit({ type: 'output', text });
    }
  },
};
