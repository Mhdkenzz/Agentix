// Agentix — remember the CLI processes this server started.
// A server that dies leaves the agent CLIs running. The next server may stop a prior run only
// when its PID, executable, start time, and process-group identity still match the saved record.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, readlinkSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTIX_HOME } from './store.ts';

interface ProcessIdentity { startTime: string; executable: string; processGroup: number }
interface RunRecord { pid: number; cmd: string; agentId: string; startedAt: number; identity?: ProcessIdentity }

const runsDir = () => join(AGENTIX_HOME, 'runs');
const runFile = (pid: number) => join(runsDir(), `${pid}.json`);
// The parent server can safely signal groups it created even if persisting the run record failed.
const activeGroups = new Map<number, ProcessIdentity | undefined>();

/** Linux process identity. On platforms without /proc, cleanup is skipped rather than guessed. */
function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')'); // comm can contain spaces and parentheses
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/); // begins at field 3 (state)
    const processGroup = Number(fields[2]); // field 5
    const startTime = fields[19]; // field 22, unique across PID reuse
    const executable = readlinkSync(`/proc/${pid}/exe`);
    if (!Number.isSafeInteger(processGroup) || !startTime || !executable) return undefined;
    return { startTime, executable, processGroup };
  } catch { return undefined; }
}

function identityMatches(record: RunRecord): boolean {
  if (!record.identity) return false; // never signal old or unverifiable records
  const current = processIdentity(record.pid);
  return Boolean(current && current.startTime === record.identity.startTime
    && current.executable === record.identity.executable
    && current.processGroup === record.pid && current.processGroup === record.identity.processGroup);
}

/** A recorded group remains attributable after its leader exits, as long as that PID is still absent. */
function canSignalGroup(record: RunRecord): boolean {
  if (identityMatches(record)) return true;
  if (!record.identity || existsSync(`/proc/${record.pid}`) || !groupAlive(record.pid)) return false;
  try {
    return readdirSync('/proc').some(entry => {
      if (!/^\d+$/.test(entry)) return false;
      return processIdentity(Number(entry))?.processGroup === record.identity!.processGroup;
    });
  } catch { return false; }
}

function preserveUnverified(path: string): void {
  const backup = `${path}.unverified-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.error(`agentix: preserved an old process record that cannot be verified as ${backup}; no process was signalled`);
  } catch { /* keep the record in place if it cannot be moved */ }
}

/** Remember a CLI this server started, so a server that dies does not leave it running forever. */
export function registerRun(pid: number, cmd: string, agentId: string): void {
  const identity = processIdentity(pid);
  activeGroups.set(pid, identity);
  try {
    mkdirSync(runsDir(), { recursive: true });
    const record: RunRecord = { pid, cmd, agentId, startedAt: Date.now(), ...(identity ? { identity } : {}) };
    const temporary = `${runFile(pid)}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(record));
    renameSync(temporary, runFile(pid));
  } catch { /* the run is only tracked in memory then */ }
}

/** Forget a CLI that ended on its own. */
export function unregisterRun(pid: number): void {
  const path = runFile(pid);
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
    if (canSignalGroup(record) && groupAlive(pid)) return; // a child still owns this process group
  } catch { /* missing or invalid record */ }
  const identity = activeGroups.get(pid);
  if (identity && canSignalGroup({ pid, cmd: '', agentId: '', startedAt: 0, identity }) && groupAlive(pid)) return;
  activeGroups.delete(pid);
  try { unlinkSync(path); } catch { /* already gone */ }
}

/** Signal only the exact process group previously registered by this server. */
export function signalRunGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    const record = JSON.parse(readFileSync(runFile(pid), 'utf8')) as RunRecord;
    if (record.identity) {
      if (!canSignalGroup(record)) return false; // a known mismatch always fails closed
      stopGroup(pid, signal);
      return true;
    }
  } catch { /* use the live server's in-memory record below */ }
  const identity = activeGroups.get(pid);
  if (process.platform === 'win32' || !identity || !canSignalGroup({ pid, cmd: '', agentId: '', startedAt: 0, identity })) return false;
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

export function hasRunGroup(pid: number): boolean {
  try {
    const record = JSON.parse(readFileSync(runFile(pid), 'utf8')) as RunRecord;
    if (record.identity) return canSignalGroup(record) && groupAlive(pid);
  } catch { /* use the live server's in-memory record below */ }
  const identity = activeGroups.get(pid);
  return process.platform !== 'win32' && Boolean(identity && canSignalGroup({ pid, cmd: '', agentId: '', startedAt: 0, identity }) && groupAlive(pid));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

function groupAlive(pid: number): boolean {
  // `kill(-pgid, 0)` also succeeds when the only remaining members are
  // zombies. They cannot run commands or hold files, and cannot be killed
  // again; treating them as live keeps turns and tests waiting needlessly.
  if (process.platform === 'linux') {
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
          const close = stat.lastIndexOf(')');
          if (close < 0) continue;
          const fields = stat.slice(close + 2).trim().split(/\s+/);
          if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
        } catch { /* process exited while /proc was being scanned */ }
      }
      return false;
    } catch { /* /proc is unavailable; fall back to the portable process-group probe */ }
  }
  try { process.kill(-pid, 0); return true; } catch (err: any) { return err?.code === 'EPERM'; }
}

/** Signal only the process group; falling back to a bare PID could hit a reused, unrelated process. */
function stopGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* group is gone or cannot be verified */ }
}

/**
 * Stop CLIs left behind by a previous server. PID reuse is checked against the exact executable,
 * kernel start time, and process-group ID before each signal. Returns how many groups were stopped.
 */
export async function killOrphanRuns(): Promise<number> {
  let files: string[];
  try { files = readdirSync(runsDir()); } catch { return 0; }
  const records: RunRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const path = join(runsDir(), file);
    let record: RunRecord | undefined;
    try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { record = undefined; }
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1 || Number(file.slice(0, -5)) !== record.pid) {
      preserveUnverified(path);
      continue;
    }
    if (!record.identity || typeof record.identity.startTime !== 'string'
      || typeof record.identity.executable !== 'string' || !Number.isSafeInteger(record.identity.processGroup)) {
      // Incomplete records do not contain enough identity data to safely signal after a crash.
      preserveUnverified(path);
      continue;
    }
    if (!canSignalGroup(record)) {
      // A PID can be reused. If identity cannot be proven, leave that process alone.
      if (existsSync(`/proc/${record.pid}`)) forget(path); // PID now belongs to a different process.
      else if (!groupAlive(record.pid)) forget(path);
      continue;
    }
    if (isAlive(record.pid) || groupAlive(record.pid)) records.push(record);
    else forget(path);
  }
  if (!records.length) return 0;

  for (const record of records) if (canSignalGroup(record)) stopGroup(record.pid, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const record of records) {
    // Recheck identity after the grace period; the PID could have exited and been reused meanwhile.
    if (canSignalGroup(record) && groupAlive(record.pid)) stopGroup(record.pid, 'SIGKILL');
    if (!canSignalGroup(record) || !groupAlive(record.pid)) forget(runFile(record.pid));
  }
  return records.length;
}

function forget(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}
