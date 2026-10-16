// Agentix — Claude Code CLI adapter
// WARNING: kenz loses access on Oct 17. Write it but don't block on testing.
// Flags: `claude -p "<prompt>" --output-format stream-json --verbose`
// Resume: `--resume <session_id>`
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEvent } from '../../shared/src/types.ts';
import type { AgentAdapter, AdapterContext } from './types';

const execFileAsync = promisify(execFile);

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',

  async detect() {
    try {
      const { stdout } = await execFileAsync('which', ['claude']);
      return { installed: true, version: 'unknown' };
    } catch {
      return { installed: false };
    }
  },

  async send(ctx: AdapterContext, prompt: string) {
    const args: string[] = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    const env = { ...process.env, CWD: ctx.agent.cwd };

    if (ctx.agent.nativeSessionId) {
      args.splice(1, 0, '--resume', ctx.agent.nativeSessionId);
    }

    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'working', data: { status: 'working', activity: `running claude -p "${prompt.slice(0, 40)}..."` } });

    const child = execFileAsync('claude', args, {
      cwd: ctx.agent.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'init' || parsed.type === 'system') {
            const sid = (parsed.data as any)?.sessionId || (parsed.data as any)?.id;
            if (sid && !ctx.agent.nativeSessionId) {
              ctx.setNativeSessionId(String(sid));
            }
          } else if (parsed.type === 'output' || parsed.type === 'message' || parsed.type === 'text') {
            ctx.emit({ agentId: ctx.agent.id, type: 'output', text: String((parsed.data as any)?.content ?? line) });
          } else if (parsed.type === 'tool' || parsed.type === 'command' || parsed.type === 'patch') {
            ctx.emit({ agentId: ctx.agent.id, type: 'tool', text: String((parsed.data as any)?.name ?? line) });
          }
        } catch {
          // Plain text output
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
