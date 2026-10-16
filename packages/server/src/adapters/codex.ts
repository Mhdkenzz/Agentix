// Agentix — Codex CLI adapter
// Flags verified with `codex exec --help` before use.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../../shared/src/types.ts';
import type { AgentAdapter, AdapterContext } from './types';

const execFileAsync = promisify(execFile);

function parseCodexLine(line: string): { type: string; data: unknown } | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type) return parsed;
  } catch { /* not JSON */ }
  return null;
}

export const codexAdapter: AgentAdapter = {
  kind: 'codex',

  async detect() {
    try {
      const { stdout } = await execFileAsync('which', ['codex']);
      return { installed: true, version: 'unknown' };
    } catch {
      return { installed: false };
    }
  },

  async send(ctx: AdapterContext, prompt: string) {
    // Determine command based on whether we have a native session
    const args: string[] = [];
    const env = { ...process.env, CWD: ctx.agent.cwd };

    if (ctx.agent.nativeSessionId) {
      args.push('exec', 'resume', ctx.agent.nativeSessionId, prompt);
    } else {
      args.push('exec', '--json', prompt);
    }

    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'working', data: { status: 'working', activity: `running codex ${args.join(' ')}` } });

    const child = execFileAsync('codex', args, {
      cwd: ctx.agent.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parseCodexLine(line);
        if (parsed) {
          if (parsed.type === 'init' || parsed.type === 'system') {
            // Extract session id if available
            const sid = (parsed.data as any)?.sessionId || (parsed.data as any)?.id;
            if (sid && !ctx.agent.nativeSessionId) {
              ctx.setNativeSessionId(String(sid));
            }
          } else if (parsed.type === 'item' || parsed.type === 'message' || parsed.type === 'output') {
            ctx.emit({ agentId: ctx.agent.id, type: 'output', text: String((parsed.data as any)?.content ?? line) });
          } else if (parsed.type === 'tool' || parsed.type === 'command' || parsed.type === 'patch') {
            ctx.emit({ agentId: ctx.agent.id, type: 'tool', text: String((parsed.data as any)?.name ?? (parsed.data as any)?.action ?? line) });
          }
        } else {
          ctx.emit({ agentId: ctx.agent.id, type: 'output', text: line });
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      ctx.emit({ agentId: ctx.agent.id, type: 'error', text: data.toString().trim() });
    });

    await child;
    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'idle', data: { status: 'idle', activity: 'idle' } });
  },

  async interrupt(ctx: AdapterContext) {
    // Codex doesn't have a direct interrupt API via CLI,
    // but we can signal the process from the session manager.
    // For now, emit a stop event.
    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'stopped', data: { status: 'stopped', activity: 'interrupted' } });
  },
};
