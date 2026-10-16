// Agentix — helpers for adapters that drive an external CLI
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AdapterContext } from './types.ts';
import { cliPath } from '../settings.ts';

/** Grace period between SIGINT and SIGTERM when a turn is interrupted. */
export const KILL_GRACE_MS = Number(process.env.AGENTIX_KILL_GRACE_MS) || 3000;

/** `<cmd> --version`, or not installed if it can't be run. `cmd` is the adapter kind; Settings can override its path. */
export function detectCli(cmd: string): Promise<{ installed: boolean; version?: string }> {
  return new Promise(resolve => {
    execFile(cliPath(cmd), ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err && (err as any).code === 'ENOENT') return resolve({ installed: false });
      const version = String(stdout || '').trim().split('\n')[0];
      resolve(err && !version ? { installed: false } : { installed: true, version: version || 'unknown' });
    });
  });
}

/**
 * Spawn a CLI in the agent's cwd, call `onLine` for every stdout line, and
 * resolve when it exits. On abort: SIGINT to the process group, then SIGTERM
 * after KILL_GRACE_MS. Rejects if the process fails or exits non-zero (unless aborted).
 */
export function runCli(
  ctx: AdapterContext,
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return resolve();

    const child = spawn(cliPath(cmd), args, {
      cwd: ctx.agent.cwd,
      // PWD too: some CLIs (opencode) trust $PWD over the real cwd, and ours is the server's
      env: { ...process.env, PWD: ctx.agent.cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so we can stop the CLI's children too
    });

    // Signal the whole process group: the CLI may have exited already while a
    // child it started (holding our stdout pipe open) is still running.
    let closed = false;
    const kill = (sig: NodeJS.Signals) => {
      if (closed) return;
      try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    let termTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      kill('SIGINT');
      termTimer = setTimeout(() => kill('SIGTERM'), KILL_GRACE_MS);
      termTimer.unref();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    createInterface({ input: child.stdout! }).on('line', line => {
      if (!line.trim()) return;
      try { onLine(line); } catch (err: any) {
        ctx.emit({ type: 'error', text: `adapter parse error: ${err?.message ?? err}` });
      }
    });

    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', err => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    // If the CLI exits but leaves a background child holding stdout, don't wait forever.
    child.on('exit', () => {
      setTimeout(() => { if (!closed) { child.stdout!.destroy(); child.stderr!.destroy(); } }, 2000).unref();
    });
    child.on('close', (code, sig) => {
      closed = true;
      ctx.signal.removeEventListener('abort', onAbort);
      if (termTimer) clearTimeout(termTimer);
      if (ctx.signal.aborted || code === 0) return resolve();
      const tail = stderr.trim().split('\n').slice(-5).join('\n');
      reject(new Error(`${cmd} exited with ${code ?? sig}${tail ? `: ${tail}` : ''}`));
    });
  });
}

export function parseJson(line: string): any | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function oneLine(s: unknown, max = 120): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
