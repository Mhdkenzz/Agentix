import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, readlinkSync, statSync, linkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface ProcessIdentity { startTime: string; executable: string }
interface LockRecord { pid: number; nonce: string; identity?: ProcessIdentity }

const home = () => process.env.AGENTIX_HOME || join(homedir(), '.agentix');
const lockPath = () => join(home(), 'server.lock');
const recoveryPath = () => join(home(), 'server.lock.recover');

function currentIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const startTime = stat.slice(close + 2).trim().split(/\s+/)[19];
    const executable = readlinkSync(`/proc/${pid}/exe`);
    return startTime && executable ? { startTime, executable } : undefined;
  } catch { return undefined; }
}

function ownerIsAlive(record: LockRecord): boolean {
  const actual = currentIdentity(record.pid);
  if (record.identity && actual) return actual.startTime === record.identity.startTime && actual.executable === record.identity.executable;
  if (actual) return true; // legacy lock from a live PID: block rather than risk double-starting
  try { process.kill(record.pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}

function readRecord(path = lockPath()): { raw: string; record?: LockRecord } | undefined {
  try {
    const raw = readFileSync(path, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      return { raw, record: Number.isSafeInteger(parsed?.pid) && typeof parsed?.nonce === 'string' ? parsed : undefined };
    } catch { return { raw }; }
  } catch (error: any) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function createRecord(): LockRecord {
  return { pid: process.pid, nonce: randomBytes(16).toString('hex'), ...(currentIdentity(process.pid) ? { identity: currentIdentity(process.pid) } : {}) };
}

function writeExclusive(path: string, record: LockRecord): boolean {
  const temp = `${path}.${record.nonce}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(temp, path); // publish the complete record atomically without replacing an existing lock
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
}

/** One server owns each data folder so its in-memory caches and orphan cleanup cannot race. */
export function acquireServerLock(): () => void {
  mkdirSync(home(), { recursive: true });
  const ours = createRecord();
  if (!writeExclusive(lockPath(), ours)) {
    const previous = readRecord();
    if (previous?.record && ownerIsAlive(previous.record)) {
      throw new Error(`another Agentix server is already using this data folder (pid ${previous.record.pid})`);
    }

    // Serialize stale-lock recovery, then compare the record again before removing it.
    const recovery = createRecord();
    if (!writeExclusive(recoveryPath(), recovery)) {
        const staleRecovery = readRecord(recoveryPath());
        let abandonedMarker = false;
        try { abandonedMarker = Date.now() - statSync(recoveryPath()).mtimeMs > 10_000; } catch { /* marker disappeared */ }
        if ((staleRecovery?.record && !ownerIsAlive(staleRecovery.record)) || (!staleRecovery?.record && abandonedMarker)) {
          try { unlinkSync(recoveryPath()); } catch { /* another starter may have cleared it */ }
          throw new Error('removed a stale Agentix lock-recovery marker; retry startup');
        }
        throw new Error('another Agentix startup is recovering the server lock; retry shortly');
    }
    try {
      const current = readRecord();
      if (!previous || !current || current.raw !== previous.raw || (current.record && ownerIsAlive(current.record))) {
        throw new Error('the Agentix server lock changed during recovery; retry startup');
      }
      unlinkSync(lockPath());
    } finally {
      if (readRecord(recoveryPath())?.record?.nonce === recovery.nonce) {
        try { unlinkSync(recoveryPath()); } catch { /* best effort */ }
      }
    }
    if (!writeExclusive(lockPath(), ours)) throw new Error('another Agentix server started first; use its existing dashboard');
  }

  return () => {
    const current = readRecord();
    if (current?.record?.nonce === ours.nonce) {
      try { unlinkSync(lockPath()); } catch { /* already released */ }
    }
  };
}
