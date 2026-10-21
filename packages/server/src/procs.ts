// Agentix — remember the CLI processes this server started.
//
// A server that dies (a crash, a killed terminal, a closed laptop) leaves the agent CLIs running:
// they keep burning tokens with nobody watching. Every CLI runs in its own process group and its
// pid is written to $AGENTIX_HOME/runs/, so the next server start finds them and stops them.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AGENTIX_HOME } from './store.ts';

interface RunRecord { pid: number; cmd: string; agentId: string; startedAt: number }

const runsDir = () => join(AGENTIX_HOME, 'runs');
const runFile = (pid: number) => join(runsDir(), `${pid}.json`);

/** Remember a CLI this server started, so it can be stopped if the server dies. */
export function registerRun(pid: number, cmd: string, agentId: string): void {
  try {
    mkdirSync(runsDir(), { recursive: true });
    const record: RunRecord = { pid, cmd, agentId, startedAt: Date.now() };
    writeFileSync(runFile(pid), JSON.stringify(record));
  } catch { /* the run is only tracked in memory then */ }
}

/** Forget a CLI that ended on its own. */
export function unregisterRun(pid: number): void {
  try { unlinkSync(runFile(pid)); } catch { /* already gone */ }
}

/** Is this pid still running? */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

/** The command line of a running process, or undefined when it cannot be read. */
async function commandLine(pid: number): Promise<string | undefined> {
  try {
    // Linux: the kernel keeps it.
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter(Boolean).join(' ');
  } catch { /* not Linux, or the process is gone */ }
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-p', String(pid), '-o', 'args='], { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout).trim());
      });
    });
  } catch { return undefined; }
}

/** Signal the whole process group: the CLI may have children of its own. */
function stopGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

/**
 * Stop the CLIs a previous server left behind. A pid is only killed when it still runs the
 * binary we started (a pid can be reused by something else in the meantime).
 * Returns how many processes were stopped.
 */
export async function killOrphanRuns(): Promise<number> {
  let files: string[];
  try { files = readdirSync(runsDir()); } catch { return 0; }
  const pids: number[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const path = join(runsDir(), file);
    let record: RunRecord | undefined;
    try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { record = undefined; }
    if (!record || !Number.isInteger(record.pid)) { forget(path); continue; }
    if (!isAlive(record.pid)) { forget(path); continue; }
    const name = basename(record.cmd || '');
    const line = await commandLine(record.pid);
    if (line !== undefined && name && !line.includes(name)) {
      // The pid belongs to something else now: leave it alone.
      forget(path);
      continue;
    }
    pids.push(record.pid);
    forget(path);
  }
  if (!pids.length) return 0;
  for (const pid of pids) stopGroup(pid, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const pid of pids) if (isAlive(pid)) stopGroup(pid, 'SIGKILL');
  return pids.length;
}

function forget(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}
