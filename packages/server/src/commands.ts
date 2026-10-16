// Agentix — the @@ command language the coordinator and CEO use to direct other agents.
//
//   @@spawn kind=codex name=Rook avatar=random cwd=/path :: <task>
//   @@steer <agent id or name> :: <instructions>
//   @@stop <agent id or name>
//   @@tell <coordinator|ceo> :: <message>
//
// Commands must start a line (leading spaces and markdown bullets/backticks are allowed).

export type Command =
  | { op: 'spawn'; opts: Record<string, string>; text: string; line: string }
  | { op: 'steer'; target: string; text: string; line: string }
  | { op: 'stop'; target: string; line: string }
  | { op: 'tell'; target: string; text: string; line: string };

const LINE = /^\s*(?:[-*>]\s*)?`?@@(spawn|steer|stop|tell)\b(.*?)`?\s*$/i;

export function parseCommands(text: string): { commands: Command[]; errors: string[] } {
  const commands: Command[] = [];
  const errors: string[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const op = m[1].toLowerCase();
    const rest = m[2];
    const sep = rest.indexOf('::');
    const head = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
    const body = sep >= 0 ? rest.slice(sep + 2).trim() : '';
    const line = raw.trim();
    if (op === 'spawn') {
      const opts: Record<string, string> = {};
      for (const tok of head.match(/\w+=(?:"[^"]*"|\S+)/g) ?? []) {
        const i = tok.indexOf('=');
        opts[tok.slice(0, i).toLowerCase()] = tok.slice(i + 1).replace(/^"|"$/g, '');
      }
      if (!opts.kind) { errors.push(`${line}: spawn needs kind=<agent kind>`); continue; }
      commands.push({ op: 'spawn', opts, text: body, line });
    } else if (op === 'stop') {
      if (!head) { errors.push(`${line}: stop needs an agent`); continue; }
      commands.push({ op: 'stop', target: head, line });
    } else {
      if (!head || !body) { errors.push(`${line}: ${op} needs "<target> :: <text>"`); continue; }
      commands.push({ op: op as 'steer' | 'tell', target: head, text: body, line });
    }
  }
  return { commands, errors };
}

/** Lines that aren't @@ commands, e.g. what the CEO should say out loud. */
export function stripCommands(text: string): string {
  return String(text ?? '').split('\n').filter(l => !LINE.test(l)).join('\n').trim();
}

export const COORDINATOR_INSTRUCTIONS = `[AGENTIX] You are the COORDINATOR of a team of AI coding agents run by Agentix.
kenz (the human) and the CEO agent talk to you; you direct the worker agents.
You receive "[AGENTIX UPDATE]" messages when workers finish, fail or are steered by kenz, plus a team digest.
To act on the team, write commands on their own lines in your reply (the server runs them):
  @@spawn kind=<codex|opencode|claude|mock> name=<Name> avatar=random cwd=<absolute path> :: <task>
  @@steer <agent id or name> :: <instructions>
  @@stop <agent id or name>
  @@tell ceo :: <short report for the CEO>
Keep commands to what the work needs. Anything else you write is shown to kenz.`;

export const CEO_INSTRUCTIONS = `[AGENTIX] You are the CEO of a team of AI coding agents run by Agentix. kenz talks to you, often by voice,
so answer in short, plain spoken sentences (no markdown, no code blocks).
You never direct workers yourself. To get something done, tell the coordinator with a line:
  @@tell coordinator :: <what you want done>
Each message from kenz comes with a [TEAM STATUS] digest of every agent, so you always know what the team is doing.`;
