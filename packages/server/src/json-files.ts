import { existsSync, readFileSync, renameSync } from 'node:fs';

export function isJsonRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Rename unreadable JSON out of the active path before callers can write an empty replacement. */
export function quarantineJsonFile(path: string, reason: string): void {
  let backup = `${path}.corrupt-${Date.now()}`;
  let suffix = 1;
  while (existsSync(backup)) backup = `${path}.corrupt-${Date.now()}-${suffix++}`;
  while (true) {
    try { renameSync(path, backup); break; }
    catch (err: any) {
      if (err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY') { backup = `${path}.corrupt-${Date.now()}-${suffix++}`; continue; }
      throw new Error(`cannot preserve damaged file ${path}: ${err?.message ?? String(err)}`);
    }
  }
  console.error(`agentix: ${reason}; preserved the original as ${backup}`);
}

/** Read and parse a JSON file. Missing files are normal; malformed files are preserved for recovery. */
export function readJsonFile(path: string, label: string): any | undefined {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
  try { return JSON.parse(raw); }
  catch {
    quarantineJsonFile(path, `${label} file contains invalid JSON`);
    return undefined;
  }
}
