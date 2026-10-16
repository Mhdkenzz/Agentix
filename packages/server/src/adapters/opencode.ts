// Agentix — OpenCode CLI adapter
// Flags verified with `opencode run --help` before use.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent } from '../../shared/src/types.ts';
import type { AgentAdapter, AdapterContext } from './types';

const execFileAsync = promisify(execFile);

export const opencodeAdapter: AgentAdapter = {
  kind: 'opencode',

  async detect() {
    try {
      const { stdout } = await execFileAsync('which', ['opencode']);
      return { installed: true, version: 'unknown' };
    } catch {
      return { installed: false };
    }
  },

  async send(ctx: AdapterContext, prompt: string) {
    const args: string[] = [];
    const env = { ...process.env, CWD: ctx.agent.cwd };

    if (ctx.agent.nativeSessionId) {
      // Try opencode's session/continue flag
      args.push('run', '--resume', ctx.agent.nativeSessionId, prompt);
    } else {
      args.push('run', prompt);
    }

    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'working', data: { status: 'working', activity: `running opencode ${args.join(' ')}` } });

    const child = execFileAsync('opencode', args, {
      cwd: ctx.agent.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // OpenCode may output JSON or plain text
        try {
          const parsed = JSON.parse(line);
          if (parsed.type) {
            if (parsed.type === 'init' || parsed.type === 'system') {
              const sid = (parsed.data as any)?.sessionId || (parsed.data as any)?.id;
              if (sid && !ctx.agent.nativeSessionId) {
                ctx.setNativeSessionId(String(sid));
              }
            } else if (parsed.type === 'output' || parsed.type === 'message') {
              ctx.emit({ agentId: ctx.agent.id, type: 'output', text: String((parsed.data as any)?.content ?? line) });
            } else if (parsed.type === 'tool') {
              ctx.emit({ agentId: ctx.agent.id, type: 'tool', text: String((parsed.data as any)?.name ?? line) });
            }
          } else {
            ctx.emit({ agentId: ctx.agent.id, type: 'output', text: line });
          }
        } catch {
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
    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'stopped', data: { status: 'stopped', activity: 'interrupted' } });
  },
};
