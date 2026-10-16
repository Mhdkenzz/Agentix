// Agentix — Goose adapter (Block's goose CLI)
// NOT YET RUN AGAINST A REAL CLI: written from the documentation, tested with a fake CLI only.
//   new:    goose run --name <name> --text <prompt>
//   resume: goose run --name <name> --resume --text <prompt>
// The session is kept (no --no-session) and named by us, so the name is the session id. Each new
// Agentix session gets a fresh name, agentix-<agentId>-<time>, so "new session" really starts over
// instead of colliding with the old name.
// Output is plain text. Tool calls appear as a header line plus "key: value" parameter lines, e.g.
//   ─── shell | developer ──────────────────────────
//   command: ls -la
// which become tool events; the session banner ("starting session | provider: ...", "logging to ...",
// "working directory: ...") is dropped; the rest is the reply, emitted as one output at the end.
// No system-prompt flag in `goose run`, so role instructions go in front of the prompt.
import { withInstructions, type AgentAdapter, type AdapterContext } from './types.ts';
import { detectCli, runCli, oneLine, stripAnsi, plainText } from './proc.ts';

export function gooseArgs(name: string, prompt: string, resume: boolean): string[] {
  const args = ['run', '--name', name];
  if (resume) args.push('--resume');
  // clap reads a value starting with "-" as a flag unless it's attached with "="
  if (prompt.startsWith('-')) args.push(`--text=${prompt}`);
  else args.push('--text', prompt);
  return args;
}

export const newGooseSessionName = (agentId: string) => `agentix-${agentId}-${Date.now().toString(36)}`;

const BANNER = /^\s*((starting|resuming) session\b|session id:|logging to\b|working directory:|Closing session\b)/i;
const TOOL_HEADER = /^─+\s*(.+?)\s*\|\s*([\w.-]+)\s*─*\s*$/;
const PARAM = /^\s*([\w.-]+):\s*(.*)$/;
const DETAIL_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url'];

/** Reads goose's plain-text stdout: tool calls become events, the rest is kept for the reply. */
export class GooseOutput {
  readonly lines: string[] = [];
  private tool: { name: string; detail?: string } | null = null;
  private ctx: AdapterContext;

  constructor(ctx: AdapterContext) { this.ctx = ctx; }

  private endTool(): void {
    if (!this.tool) return;
    const { name, detail } = this.tool;
    this.tool = null;
    const text = `${name}${detail ? `: ${oneLine(detail)}` : ''}`;
    this.ctx.emit({ type: 'tool', text, data: { tool: name, detail } });
    this.ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: text } });
  }

  line(raw: string): void {
    const line = stripAnsi(raw);
    const header = TOOL_HEADER.exec(line.trim());
    if (header) { this.endTool(); this.tool = { name: header[1] }; return; }
    if (this.tool) {
      const p = PARAM.exec(line);
      if (p && line.trim()) {
        if (!this.tool.detail && DETAIL_KEYS.includes(p[1]) && p[2]) this.tool.detail = p[2];
        return; // parameters are part of the tool event, not the reply
      }
      this.endTool();
      if (!line.trim()) return;
    }
    if (BANNER.test(line)) return;
    this.lines.push(line);
  }

  finish(): string {
    this.endTool();
    return plainText(this.lines);
  }
}

export const gooseAdapter: AgentAdapter = {
  kind: 'goose',

  detect: () => detectCli('goose'),

  async send(ctx, prompt) {
    ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: 'working (Goose reports when done)' } });
    const resume = Boolean(ctx.agent.nativeSessionId);
    const name = ctx.agent.nativeSessionId ?? newGooseSessionName(ctx.agent.id);
    const out = new GooseOutput(ctx);
    try {
      // goose run takes its model from GOOSE_MODEL (with the provider from goose's own config)
      if (ctx.agent.model) ctx = { ...ctx, env: { ...ctx.env, GOOSE_MODEL: ctx.agent.model } };
      await runCli(ctx, 'goose', gooseArgs(name, withInstructions(ctx, prompt), resume), line => out.line(line), undefined, true);
    } finally {
      const text = out.finish();
      if (text && !ctx.signal.aborted) ctx.emit({ type: 'output', text });
    }
    // only now: a failed first turn may not have created the session, and --resume would then fail
    ctx.setNativeSessionId(name);
  },
};
