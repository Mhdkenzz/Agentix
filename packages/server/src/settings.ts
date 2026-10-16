// Agentix — server settings, kept in $AGENTIX_HOME/settings.json.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTIX_HOME } from './store.ts';

export type CoordinatorMode = 'human' | 'agent' | 'both';

export interface Settings {
  /**
   * human: kenz coordinates; a coordinator agent (if any) gets no updates and its @@ commands are ignored.
   * agent: the coordinator agent directs workers; the dashboard sends kenz's worker instructions through it.
   * both:  the coordinator directs and is kept informed, and kenz can still steer anyone directly.
   */
  coordinatorMode: CoordinatorMode;
  /** per-adapter CLI path overrides, e.g. { "codex": "/opt/codex/bin/codex" } */
  cliPaths: Record<string, string>;
  defaultKind: string;
  defaultCwd: string;
}

const MODES: CoordinatorMode[] = ['human', 'agent', 'both'];
const DEFAULTS: Settings = { coordinatorMode: 'both', cliPaths: {}, defaultKind: 'codex', defaultCwd: '' };
const file = () => join(AGENTIX_HOME, 'settings.json');

let cache: Settings | undefined;

export function getSettings(): Settings {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) }; } catch { cache = { ...DEFAULTS, cliPaths: {} }; }
  return cache!;
}

export class SettingsError extends Error {}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings() };
  if (patch.coordinatorMode !== undefined) {
    if (!MODES.includes(patch.coordinatorMode)) throw new SettingsError(`coordinatorMode must be one of ${MODES.join(', ')}`);
    next.coordinatorMode = patch.coordinatorMode;
  }
  if (patch.cliPaths !== undefined) {
    if (typeof patch.cliPaths !== 'object' || patch.cliPaths === null) throw new SettingsError('cliPaths must be an object');
    next.cliPaths = Object.fromEntries(Object.entries(patch.cliPaths).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
  }
  if (typeof patch.defaultKind === 'string') next.defaultKind = patch.defaultKind;
  if (typeof patch.defaultCwd === 'string') next.defaultCwd = patch.defaultCwd.trim();
  mkdirSync(join(file(), '..'), { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify(next, null, 2));
  renameSync(file() + '.tmp', file());
  cache = next;
  return next;
}

/** The binary to run for an adapter: settings override, then AGENTIX_<KIND>_BIN, then the plain name on PATH. */
export function cliPath(kind: string): string {
  return getSettings().cliPaths[kind] || process.env[`AGENTIX_${kind.toUpperCase()}_BIN`] || kind;
}
