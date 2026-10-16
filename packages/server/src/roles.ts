// Agentix — how each role should work, from AGENTS.md: "## Everyone" plus the role's own section.
// kenz's copy in $AGENTIX_HOME/AGENTS.md wins over the default shipped in packages/server/roles/AGENTS.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '../../shared/src/types.ts';
import { AGENTIX_HOME } from './store.ts';

export const DEFAULT_AGENTS_MD = fileURLToPath(new URL('../roles/AGENTS.md', import.meta.url));
const HEADINGS: Record<Role, string> = { ceo: 'ceo', coordinator: 'coordinator', worker: 'worker' };

function read(path: string): string | undefined {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
}

/** The "## <name>" sections of a markdown file, by lowercased heading. */
export function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = '';
  let body: string[] = [];
  const flush = () => { if (name) out.set(name, body.join('\n').trim()); };
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { flush(); name = h[1].toLowerCase(); body = []; }
    else if (name) body.push(line);
  }
  flush();
  return out;
}

/** The AGENTS.md guidance for one role, or '' when there is none. Read fresh each time so edits apply to new sessions. */
export function roleGuide(role: Role, md = read(join(AGENTIX_HOME, 'AGENTS.md')) ?? read(DEFAULT_AGENTS_MD) ?? ''): string {
  const s = sections(md);
  const parts = [s.get('everyone'), s.get(HEADINGS[role])].filter(Boolean);
  return parts.length ? `[AGENTS.MD] How to work as the ${role}:\n${parts.join('\n\n')}` : '';
}
