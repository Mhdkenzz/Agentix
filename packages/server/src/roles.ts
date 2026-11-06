// Agentix — how each role should work, from AGENTS.md: "## Everyone" plus the role's own section.
// kenz's copy in $AGENTIX_HOME/AGENTS.md wins over the default shipped in packages/server/roles/AGENTS.md.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role } from '../../shared/src/types.ts';
import { AGENTIX_HOME } from './store.ts';

export const DEFAULT_AGENTS_MD = fileURLToPath(new URL('../roles/AGENTS.md', import.meta.url));
const ROLE_SKILLS_DIR = fileURLToPath(new URL('../roles/skills/', import.meta.url));
const HEADINGS: Record<Role, string> = { ceo: 'ceo', coordinator: 'coordinator', worker: 'worker' };
const WORKER_PERMISSION_PROTOCOL = `[PERMISSION PROTOCOL]
Treat the assigned prompt and task as permission only for the work they describe. Ask the coordinator before expanding scope, making destructive changes, changing shared interfaces, or causing external side effects such as deployment, publishing, sending messages, installing tools or spending money.
Request approval with @@tell coordinator :: PERMISSION REQUEST: <proposed action, reason and impact>. Do not perform that action until the coordinator explicitly approves. If a task exists, mark it blocked with a short approval-wait note; otherwise end the turn after asking.
Normal reads, edits and commands needed to complete the assigned task are already authorized; do not ask permission for every small step.`;

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
  const guide = parts.length ? `[AGENTS.MD] How to work as the ${role}:\n${parts.join('\n\n')}` : '';
  let skills: string[] = [];
  try {
    const roleDir = join(ROLE_SKILLS_DIR, role);
    skills = readdirSync(roleDir).sort().flatMap(entry => {
      const path = join(roleDir, entry);
      try {
        if (statSync(path).isDirectory()) return readdirSync(path).filter(file => file.endsWith('.md')).sort().map(file => read(join(path, file)));
      } catch { /* optional skill folder */ }
      return entry.endsWith('.md') ? [read(path)] : [];
    }).filter((text): text is string => Boolean(text?.trim()));
  } catch { /* the role guide still works if optional skill files are missing */ }
  const skillBlock = skills.length ? `[ROLE SKILLS]\n${skills.join('\n\n')}` : '';
  const permission = role === 'worker' ? WORKER_PERMISSION_PROTOCOL : '';
  return [guide, skillBlock, permission].filter(Boolean).join('\n\n');
}
