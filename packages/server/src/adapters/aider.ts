// Agentix — Aider adapter (`pip install aider-chat`)
// Flags checked against aider-chat 0.86.2 (aider/args.py); not yet run against a real model here.
//   aider --message <prompt> --yes-always --no-pretty --no-stream --no-fancy-input --no-check-update
//         --no-show-model-warnings --no-analytics [--restore-chat-history]
// Aider has no session ids: it keeps the conversation in .aider.chat.history.md in the cwd, so a "resume"
// is --restore-chat-history, and the session id we show is "aider:<cwd>". A new session (no id yet) runs
// without it and starts with no memory; the history file itself is never deleted.
// --no-analytics: --yes-always would otherwise accept aider's analytics opt-in question for kenz.
// Output is plain text (no JSON mode), printed when the reply is done. Lines we recognise:
//   "Applied edit to <file>"       → tool event
//   "Commit <hash> <message>"      → tool event (aider commits its edits in a git repo)
//   "Tokens: 2.3k sent, 1.1k cache write, 4.5k cache hit, 120 received." and
//   "Cost: $0.01 message, $0.02 session." → usage (approximate: aider rounds to 0.1k)
// The startup banner (version, models, repo) is dropped; everything else is the reply.
// No system-prompt flag, so role instructions go in front of the prompt.
import { withInstructions, type AgentAdapter, type AdapterContext } from './types.ts';
import { detectCli, runCli, oneLine, stripAnsi, plainText, UsageTally, type UsageParts } from './proc.ts';

export function aiderArgs(prompt: string, resume: boolean, model?: string): string[] {
  // argparse reads a value starting with "-" as a flag unless it's attached with "="
  const message = prompt.startsWith('-') ? [`--message=${prompt}`] : ['--message', prompt];
  const args = [...message, '--yes-always', '--no-pretty', '--no-stream', '--no-fancy-input', '--no-check-update', '--no-show-model-warnings', '--no-analytics'];
  if (resume) args.push('--restore-chat-history');
  if (model) args.push('--model', model);
  return args;
}

export const aiderSessionId = (cwd: string) => `aider:${cwd}`;

const BANNER = [
  /^Aider v\d/,
  /^(Main|Weak|Editor) model:/,
  /^Model:/,
  /^Git repo:/,
  /^Repo-map:/,
  /^Restored previous conversation history\.?$/,
  /^Added .+ to the chat\.?$/,
  /^Use \/help\b/,
  /^https:\/\/aider\.chat\//,
  /\(Y\)es\/\(N\)o.*\[(Yes|No)\]:/, // a confirmation --yes-always answered
];
const APPLIED = /^Applied edit to (.+)$/;
const COMMIT = /^Commit ([0-9a-f]{7,40}) (.+)$/;
const TOKENS = /^Tokens:\s*(.+)$/;
const COST = /Cost:\s*\$([\d.]+)\s+message/;

function scaled(n: string, unit = ''): number {
  const mult = unit.toLowerCase() === 'k' ? 1e3 : unit.toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(Number(n.replace(/,/g, '')) * mult);
}

/** Usage from aider's "Tokens: ... Cost: ..." report line(s), or null if the line isn't one. */
export function parseAiderUsage(line: string): UsageParts | null {
  const t = line.trim();
  const m = TOKENS.exec(t);
  if (!m) {
    const c = /^Cost:/.test(t) ? COST.exec(t) : null;
    return c ? { cost: Number(c[1]) } : null;
  }
  const u: Record<string, number> = {};
  const keys: Record<string, string> = { sent: 'input', received: 'output', 'cache write': 'cacheWrite', 'cache hit': 'cacheRead' };
  for (const p of m[1].matchAll(/([\d.,]+)\s*([kKmM])?\s+(sent|received|cache write|cache hit)\b/g)) {
    u[keys[p[3]]] = (u[keys[p[3]]] ?? 0) + scaled(p[1], p[2]);
  }
  const c = COST.exec(m[1]);
  if (c) u.cost = Number(c[1]);
  return u;
}

/** One line of aider's stdout: tool, usage, banner (dropped) or part of the reply (returned). */
export function handleAiderLine(ctx: AdapterContext, raw: string, usage: UsageTally): string | null {
  const line = stripAnsi(raw);
  const t = line.trim();
  let m: RegExpExecArray | null;
  if ((m = APPLIED.exec(t))) {
    const tool = `edit: ${oneLine(m[1])}`;
    ctx.emit({ type: 'tool', text: tool, data: { file: m[1] } });
    ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
    return null;
  }
  if ((m = COMMIT.exec(t))) {
    ctx.emit({ type: 'tool', text: `git commit ${m[1]}: ${oneLine(m[2])}`, data: { hash: m[1], message: m[2] } });
    return null;
  }
  const u = parseAiderUsage(t);
  if (u) { usage.add(u); return null; }
  if (BANNER.some(re => re.test(t))) return null;
  return line;
}

export const aiderAdapter: AgentAdapter = {
  kind: 'aider',

  detect: () => detectCli('aider'),

  async send(ctx, prompt) {
    ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: 'working (Aider reports when done)' } });
    const lines: string[] = [];
    const usage = new UsageTally();
    try {
      await runCli(ctx, 'aider', aiderArgs(withInstructions(ctx, prompt), Boolean(ctx.agent.nativeSessionId), ctx.agent.model), line => {
        const text = handleAiderLine(ctx, line, usage);
        if (text !== null) lines.push(text);
      }, undefined, true);
    } finally {
      const text = plainText(lines);
      if (text && !ctx.signal.aborted) ctx.emit({ type: 'output', text });
      usage.emit(ctx);
    }
    ctx.setNativeSessionId(aiderSessionId(ctx.agent.cwd));
  },
};
