// Agentix — Gemini CLI adapter (npm @google/gemini-cli)
// NOT YET RUN AGAINST A REAL CLI: written from the documentation and from reading the
// @google/gemini-cli 0.64.0 bundle (its yargs options and StreamJsonFormatter calls), tested with a fake CLI.
//   new:    gemini -p <prompt> --output-format stream-json --approval-mode auto_edit
//   resume: ... --resume <session_id>   (a full session UUID; sessions are stored per project dir, i.e. our cwd)
// --approval-mode auto_edit approves file edits; other tools that need approval (shell) are refused in
// headless mode, and the model sees the refusal. AGENTIX_GEMINI_APPROVAL=yolo approves everything.
// stream-json lines:
//   {type:'init',session_id,model}
//   {type:'message',role:'user'|'assistant',content,delta?:true}   assistant text arrives as deltas
//   {type:'tool_use',tool_name,tool_id,parameters}
//   {type:'tool_result',tool_id,status:'success'|'error',output?,error?:{type,message}}
//   {type:'error',severity:'warning'|'error',message}
//   {type:'result',status:'success'|'error',error?:{type,message},
//    stats:{total_tokens,input_tokens,output_tokens,cached,input,duration_ms,tool_calls,models}}
// Field names have moved between versions, so every read below falls back to likely alternatives.
// There is no system-prompt flag (GEMINI_SYSTEM_MD replaces the whole prompt), so role instructions go in the prompt.
import { withInstructions, type AgentAdapter, type AdapterContext } from './types.ts';
import { detectCli, runCli, parseJson, oneLine, emitUsage, count } from './proc.ts';

const APPROVAL = process.env.AGENTIX_GEMINI_APPROVAL || 'auto_edit';

export function geminiArgs(prompt: string, sessionId?: string, model?: string): string[] {
  // A leading "-" would make yargs read the prompt as a flag (and -p would have no value).
  const args = ['-p', prompt.startsWith('-') ? ' ' + prompt : prompt, '--output-format', 'stream-json', '--approval-mode', APPROVAL];
  if (model) args.push('-m', model);
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

/** The text of a message's content, whether a string or a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => typeof c === 'string' ? c : (c?.text ?? '')).join('');
  return '';
}

/** One turn's state: assistant deltas are joined into one output per message, the final stats into usage. */
export class GeminiTurn {
  private text = '';
  private tools = new Map<string, string>();
  private stats: any;
  failure?: string;
  private ctx: AdapterContext;

  constructor(ctx: AdapterContext) { this.ctx = ctx; }

  /** End the current assistant message: emit its joined deltas as one output. */
  flush(): void {
    const text = this.text.trim();
    this.text = '';
    if (text) this.ctx.emit({ type: 'output', text });
  }

  handle(ev: any): void {
    const ctx = this.ctx;
    const sid = ev.session_id ?? ev.sessionId;
    if (sid && String(sid) !== ctx.agent.nativeSessionId) ctx.setNativeSessionId(String(sid));

    switch (ev.type) {
      case 'init':
        ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: ev.model ? `thinking (${ev.model})` : 'thinking…' } });
        return;
      case 'message': {
        const role = ev.role ?? ev.message?.role;
        if (role !== 'assistant' && role !== 'model' && role !== 'gemini') { this.flush(); return; }
        const content = textOf(ev.content ?? ev.text ?? ev.message?.content);
        if (ev.delta) this.text += content;
        else { this.flush(); this.text = content; this.flush(); }
        return;
      }
      case 'thought':
      case 'thinking':
        ctx.emit({ type: 'status', text: 'thinking', data: { status: 'thinking', activity: oneLine(ev.subject ?? ev.content ?? 'thinking…') } });
        return;
      case 'tool_use':
      case 'tool_call': {
        this.flush();
        const name = String(ev.tool_name ?? ev.name ?? ev.tool ?? 'tool');
        const p = ev.parameters ?? ev.args ?? ev.input ?? {};
        const detail = p.command ?? p.file_path ?? p.absolute_path ?? p.path ?? p.dir_path ?? p.pattern ?? p.query ?? p.url;
        const tool = `${name}${detail ? `: ${oneLine(detail)}` : ''}`;
        const id = ev.tool_id ?? ev.call_id ?? ev.id;
        if (id) this.tools.set(String(id), name);
        ctx.emit({ type: 'tool', text: tool, data: ev });
        ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
        return;
      }
      case 'tool_result': {
        if (ev.status !== 'error' && !ev.error) return;
        const name = this.tools.get(String(ev.tool_id ?? ev.call_id ?? ev.id)) ?? ev.tool_name ?? 'tool';
        const why = ev.error?.message ?? (typeof ev.error === 'string' ? ev.error : '');
        ctx.emit({ type: 'tool', text: `${name} failed${why ? `: ${oneLine(why, 200)}` : ''}`, data: ev });
        return;
      }
      case 'error': {
        this.flush();
        const msg = String(ev.message ?? ev.error?.message ?? 'gemini error');
        ctx.emit({ type: 'error', text: ev.severity === 'warning' ? `warning: ${msg}` : msg, data: ev });
        return;
      }
      case 'result':
        this.flush();
        if (ev.stats) this.stats = ev.stats; // whole-run totals, so the last one wins
        if (ev.status === 'error' || ev.is_error) this.failure = String(ev.error?.message ?? (typeof ev.error === 'string' ? ev.error : 'gemini: the turn failed'));
        return;
    }
  }

  /** Flush any unfinished message and emit the run's token use. */
  finish(): void {
    this.flush();
    const s = this.stats ?? {};
    const input = s.input_tokens ?? s.prompt_tokens ?? s.promptTokenCount;
    const output = count(s.output_tokens ?? s.candidates_tokens ?? s.candidatesTokenCount) + count(s.thoughts_tokens ?? s.thoughtsTokenCount);
    emitUsage(this.ctx, { input, output, cacheRead: s.cached ?? s.cached_tokens ?? s.cachedContentTokenCount });
  }
}

export const geminiAdapter: AgentAdapter = {
  kind: 'gemini',

  detect: () => detectCli('gemini'),

  async send(ctx, prompt) {
    const turn = new GeminiTurn(ctx);
    try {
      await runCli(ctx, 'gemini', geminiArgs(withInstructions(ctx, prompt), ctx.agent.nativeSessionId, ctx.agent.model), line => {
        const ev = parseJson(line);
        if (ev) turn.handle(ev);
        else ctx.emit({ type: 'output', text: line });
      });
    } catch (err) {
      // An error result is clearer than "gemini exited with 1".
      if (!turn.failure) throw err;
    } finally {
      turn.finish();
    }
    if (turn.failure && !ctx.signal.aborted) throw new Error(turn.failure);
  },
};
