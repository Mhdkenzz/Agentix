// Agentix — helpers for adapters that drive an external CLI
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AdapterContext } from './types.ts';
import type { Usage } from '../../../shared/src/types.ts';
import { cliPath } from '../settings.ts';
import { hasRunGroup, registerRun, signalRunGroup, unregisterRun } from '../procs.ts';

/** Grace period between SIGINT and SIGTERM when a turn is interrupted. */
export const KILL_GRACE_MS = Number(process.env.AGENTIX_KILL_GRACE_MS) || 3000;
const MAX_OUTPUT_LINE_BYTES = 1024 * 1024;
const DEFAULT_TURN_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_TURN_OUTPUT_BYTES = 256 * 1024 * 1024;

function turnOutputLimit(): number {
  const raw = Number(process.env.AGENTIX_MAX_TURN_OUTPUT_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TURN_OUTPUT_BYTES;
  return Math.min(MAX_TURN_OUTPUT_BYTES, Math.max(1024 * 1024, Math.floor(raw)));
}

/** `<cmd> --version`, or not installed if it can't be run. `cmd` is the adapter kind; Settings can override its path. */
export function detectCli(cmd: string): Promise<{ installed: boolean; version?: string }> {
  return new Promise(resolve => {
    execFile(cliPath(cmd), ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err && (err as any).code === 'ENOENT') return resolve({ installed: false });
      // Some CLIs (pi) print their version on stderr.
      const version = (String(stdout || '').trim() || String(stderr || '').trim()).split('\n')[0];
      resolve(err && !version ? { installed: false } : { installed: true, version: version || 'unknown' });
    });
  });
}

/**
 * Like detectCli, but also checks `<cmd> --help` against `signature`, for names other programs use too
 * (e.g. Debian's `pi` computes digits of π). A program that doesn't match counts as not installed.
 */
export async function detectCliWithHelp(cmd: string, signature: RegExp, what: string): Promise<{ installed: boolean; version?: string }> {
  const found = await detectCli(cmd);
  if (!found.installed) return found;
  const help = await new Promise<string>(resolve => {
    execFile(cliPath(cmd), ['--help'], { timeout: 10000 }, (_err, stdout, stderr) => resolve(`${stdout ?? ''}\n${stderr ?? ''}`));
  });
  return signature.test(help) ? found : { installed: false, version: `"${cliPath(cmd)}" is not ${what}` };
}

/**
 * Spawn a CLI in the agent's cwd, call `onLine` for every stdout line, and
 * resolve when it exits. On abort: SIGINT to the process group, then SIGTERM
 * after KILL_GRACE_MS. Rejects if the process fails or exits non-zero (unless aborted).
 * Blank stdout lines are skipped unless `keepBlankLines` (plain-text CLIs, whose paragraphs need them).
 */
export function runCli(
  ctx: AdapterContext,
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  onStderrLine?: (line: string) => void,
  keepBlankLines = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return resolve();

    const env: NodeJS.ProcessEnv = { ...process.env, ...ctx.env, PWD: ctx.agent.cwd };
    // Agents must not inherit the dashboard's control credential. None of the supported CLIs
    // require it, and an agent can otherwise print it into the shared transcript.
    delete env.AGENTIX_TOKEN;
    const child = spawn(cliPath(cmd), args, {
      cwd: ctx.agent.cwd,
      // PWD too: some CLIs (opencode) trust $PWD over the real cwd, and ours is the server's
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so we can stop the CLI's children too
    });
    // Remember the process once Node confirms it has spawned, so even a very short CLI has a
    // verifiable process identity before it can exit.
    let onAbort = () => {};
    child.once('spawn', () => {
      if (child.pid) registerRun(child.pid, cliPath(cmd), ctx.agent.id);
      if (ctx.signal.aborted) onAbort();
    });

    // Signal the whole process group: the CLI may have exited already while a
    // child it started (holding our stdout pipe open) is still running.
    let closed = false;
    let settled = false;
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid && signalRunGroup(child.pid, sig)) return;
      if (!closed && process.platform !== 'win32' && child.pid) {
        // Registration can fail if the data folder is unwritable; while the child is still live,
        // the process group is the group we just created.
        try { process.kill(-child.pid, sig); } catch { /* group is gone */ }
      } else if (process.platform === 'win32' && !closed) {
        try { child.kill(sig); } catch { /* gone */ }
      }
    };
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let outputKillTimer: NodeJS.Timeout | undefined;
    let orphanKillTimer: NodeJS.Timeout | undefined;
    let outputLimitError: Error | undefined;
    let outputBytes = 0;
    const outputLimit = turnOutputLimit();
    const stopForOutputLimit = (reason: string) => {
      if (outputLimitError) return;
      outputLimitError = new Error(`${cmd} ${reason}`);
      kill('SIGTERM');
      outputKillTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      outputKillTimer.unref();
    };
    const accountOutput = (bytes: number) => {
      outputBytes += bytes;
      if (outputBytes > outputLimit) stopForOutputLimit(`exceeded the ${Math.floor(outputLimit / (1024 * 1024))} MiB turn output limit`);
    };
    onAbort = () => {
      kill('SIGINT');
      // SIGTERM, then SIGKILL: a CLI that traps both signals must still not run forever with nobody
      // watching it (it keeps burning tokens and holding resources).
      termTimer = setTimeout(() => {
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref();
      }, KILL_GRACE_MS);
      termTimer.unref();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();

    const reportStdoutLine = (line: string) => {
      if (!line.trim() && !keepBlankLines) return;
      try { onLine(line); } catch (err: any) {
        ctx.emit({ type: 'error', text: `adapter parse error: ${err?.message ?? err}` });
      }
    };
    const stdoutDecoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      accountOutput(chunk.length);
      if (outputLimitError) return;
      stdoutBuffer += stdoutDecoder.write(chunk);
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_OUTPUT_LINE_BYTES) { stopForOutputLimit(`emitted a line larger than the 1 MiB line limit`); return; }
        reportStdoutLine(line);
      }
      if (Buffer.byteLength(stdoutBuffer) > MAX_OUTPUT_LINE_BYTES) stopForOutputLimit(`emitted a line larger than the 1 MiB line limit`);
    });
    child.stdout!.on('end', () => {
      stdoutBuffer += stdoutDecoder.end();
      if (!outputLimitError && stdoutBuffer) {
        if (Buffer.byteLength(stdoutBuffer) > MAX_OUTPUT_LINE_BYTES) stopForOutputLimit(`emitted a line larger than the 1 MiB line limit`);
        else reportStdoutLine(stdoutBuffer.replace(/\r$/, ''));
      }
    });

    let stderr = '';
    const stderrDecoder = new StringDecoder('utf8');
    let stderrBuffer = '';
    child.stderr!.on('data', (d: Buffer) => {
      accountOutput(d.length);
      if (outputLimitError) return;
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      stderrBuffer += stderrDecoder.write(d);
      let newline: number;
      while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, newline).replace(/\r$/, '');
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_OUTPUT_LINE_BYTES) { stopForOutputLimit(`emitted a line larger than the 1 MiB line limit`); return; }
        if (onStderrLine) { try { onStderrLine(line); } catch { /* ignore */ } }
      }
      if (Buffer.byteLength(stderrBuffer) > MAX_OUTPUT_LINE_BYTES) stopForOutputLimit(`emitted a line larger than the 1 MiB line limit`);
    });
    child.stderr!.on('end', () => {
      stderrBuffer += stderrDecoder.end();
      if (!outputLimitError && stderrBuffer) {
        if (Buffer.byteLength(stderrBuffer) > MAX_OUTPUT_LINE_BYTES) stopForOutputLimit(`emitted a line larger than the 1 MiB line limit`);
        else if (onStderrLine) { try { onStderrLine(stderrBuffer.replace(/\r$/, '')); } catch { /* ignore */ } }
      }
    });

    child.on('error', err => {
      settled = true;
      ctx.signal.removeEventListener('abort', onAbort);
      if (child.pid) unregisterRun(child.pid);
      reject(err);
    });
    // If the CLI exits but leaves a background child holding stdout, don't wait forever.
    child.on('exit', () => {
      setTimeout(() => {
        // A CLI that exits while leaving a helper in its private process group must not orphan it.
        if (child.pid && hasRunGroup(child.pid) && !ctx.signal.aborted && !outputLimitError) {
          kill('SIGTERM');
          orphanKillTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
          orphanKillTimer.unref();
        }
        if (!closed) { child.stdout!.destroy(); child.stderr!.destroy(); }
      }, 2000).unref();
    });
    child.on('close', (code, sig) => {
      closed = true;
      ctx.signal.removeEventListener('abort', onAbort);
      const groupRemains = child.pid ? hasRunGroup(child.pid) : false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (termTimer) clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        if (outputKillTimer) clearTimeout(outputKillTimer);
        if (orphanKillTimer) clearTimeout(orphanKillTimer);
        if (child.pid) unregisterRun(child.pid);
        if (outputLimitError) return reject(outputLimitError);
        if (ctx.signal.aborted || code === 0) return resolve();
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${cmd} exited with ${code ?? sig}${tail ? `: ${tail}` : ''}`));
      };
      if (!groupRemains || !child.pid) return finish();

      // A CLI can exit successfully while a same-group helper keeps editing the working folder.
      // End that process tree and keep the scheduler slot until the group is confirmed gone.
      if (termTimer) clearTimeout(termTimer);
      kill('SIGTERM');
      if (killTimer) clearTimeout(killTimer);
      if (orphanKillTimer) clearTimeout(orphanKillTimer);
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      const poll = setInterval(() => {
        if (hasRunGroup(child.pid!)) return;
        clearInterval(poll);
        finish();
      }, 50);
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

/** Drop escape sequences (colours, cursor moves) some CLIs print even when stdout isn't a terminal. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}

/** A token count (or cost) from CLI output: missing, negative or not a number is 0. */
export function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface UsageParts { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: unknown }

/**
 * Adds up one turn's token use; `emit()` sends it as a single `usage` event, or nothing when it's all zero.
 * cacheRead, cacheWrite and cost appear only when the CLI reported them.
 */
export class UsageTally {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;

  add(u: UsageParts | null | undefined): this {
    if (!u) return this;
    this.input += count(u.input);
    this.output += count(u.output);
    this.cacheRead += count(u.cacheRead);
    this.cacheWrite += count(u.cacheWrite);
    this.cost += count(u.cost);
    return this;
  }

  get usage(): Usage | undefined {
    if (!this.input && !this.output && !this.cacheRead && !this.cacheWrite && !this.cost) return undefined;
    const u: Usage = { input: this.input, output: this.output };
    if (this.cacheRead) u.cacheRead = this.cacheRead;
    if (this.cacheWrite) u.cacheWrite = this.cacheWrite;
    if (this.cost) u.cost = Math.round(this.cost * 1e8) / 1e8; // sums of per-step costs drift in the last digits
    return u;
  }

  emit(ctx: AdapterContext): void {
    const data = this.usage;
    if (data) ctx.emit({ type: 'usage', data });
  }
}

/** Plain-text CLI output as one message: no escape codes, no trailing spaces, at most one blank line in a row. */
export function plainText(lines: string[]): string {
  return lines.map(l => stripAnsi(l).trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Emit the `usage` event of a turn the CLI reports in one piece (nothing when it's all zero). */
export function emitUsage(ctx: AdapterContext, u: UsageParts | null | undefined): void {
  new UsageTally().add(u).emit(ctx);
}
