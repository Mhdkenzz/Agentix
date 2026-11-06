import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = () => process.env.AGENTIX_HOME || join(homedir(), '.agentix');
const tokenPath = () => join(home(), 'api-token');

/** A stable per-install secret. An explicit environment token always takes precedence. */
export function getApiToken(): string {
  if (process.env.AGENTIX_TOKEN) return process.env.AGENTIX_TOKEN;
  if (process.env.AGENTIX_AUTH === 'off') return '';

  mkdirSync(home(), { recursive: true });
  const path = tokenPath();
  try {
    const token = readFileSync(path, 'utf8').trim();
    if (token) {
      try { chmodSync(path, 0o600); } catch { /* permissions may not be supported */ }
      return token;
    }
  } catch { /* create it below */ }

  const token = randomBytes(32).toString('hex');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, `${token}\n`, 'utf8');
    return token;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readFileSync(path, 'utf8').trim();
    // Never let a corrupt/empty token file turn authentication off. The file may
    // have been created by another process moments ago, but its write is sync;
    // an empty value here is therefore an invalid installation state.
    if (!existing) throw new Error(`API token file is empty: ${path}. Remove it and restart Agentix to generate a new token.`);
    return existing;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
