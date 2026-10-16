// Agentix — the @@ command language the coordinator and CEO use to direct other agents.
//
//   @@spawn kind=codex name=Rook avatar=random cwd=/path :: <task>
//   @@steer <agent id or name> :: <instructions>
//   @@stop <agent id or name>
//   @@tell <coordinator|ceo> :: <message>
//   @@remember :: <fact for the team's shared context>   (any agent, workers included)
//   @@task owner=<agent> :: <title>                      new task on the board (coordinator)
//   @@task <id> status=<todo|doing|review|done|blocked> owner=<agent> :: <note>   update a task
//                                                        (coordinator; a worker may update its own tasks)
//
// Commands must start a line (leading spaces and markdown bullets/backticks are allowed).

export type Command =
  | { op: 'spawn'; opts: Record<string, string>; text: string; line: string }
  | { op: 'steer'; target: string; text: string; line: string }
  | { op: 'stop'; target: string; line: string }
  | { op: 'tell'; target: string; text: string; line: string }
  | { op: 'remember'; text: string; line: string }
  | { op: 'task'; id?: string; opts: Record<string, string>; text: string; line: string };

const LINE = /^\s*(?:[-*>]\s*)?`?@@(spawn|steer|stop|tell|remember|task)\b(.*?)`?\s*$/i;

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
    if (op === 'task') {
      const opts = parseOpts(head);
      const id = head.split(/\s+/).find(t => t && !t.includes('='));
      if (!id && !body) { errors.push(`${line}: task needs ":: <title>" (new) or "<id> status=..." (update)`); continue; }
      commands.push({ op: 'task', ...(id ? { id } : {}), opts, text: body, line });
    } else if (op === 'remember') {
      const fact = (sep >= 0 ? body : head).trim();
      if (!fact) { errors.push(`${line}: remember needs ":: <fact>"`); continue; }
      commands.push({ op: 'remember', text: fact, line });
    } else if (op === 'spawn') {
      const opts = parseOpts(head);
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

function parseOpts(head: string): Record<string, string> {
  const opts: Record<string, string> = {};
  for (const tok of head.match(/\w+=(?:"[^"]*"|\S+)/g) ?? []) {
    const i = tok.indexOf('=');
    opts[tok.slice(0, i).toLowerCase()] = tok.slice(i + 1).replace(/^"|"$/g, '');
  }
  return opts;
}

/** Lines that aren't @@ commands, e.g. what the CEO should say out loud. */
export function stripCommands(text: string): string {
  return String(text ?? '').split('\n').filter(l => !LINE.test(l)).join('\n').trim();
}

export const COORDINATOR_INSTRUCTIONS = `[AGENTIX] You are the COORDINATOR of a team of AI coding agents run by Agentix.
kenz (the human) and the CEO agent talk to you; you direct the worker agents.
You receive "[AGENTIX UPDATE]" messages when workers finish, fail or are steered by kenz, plus a team digest.
To act on the team, write commands on their own lines in your reply (the server runs them):
  @@spawn kind=<codex|opencode|claude|pi|hermes|gemini|aider|goose> name=<Name> avatar=random cwd=<absolute path> [model=<model>] :: <task>
  @@steer <agent id or name> :: <instructions>
  @@stop <agent id or name>
  @@tell ceo :: <short report for the CEO>
  @@remember :: <a fact every agent should know, e.g. a decision, a path, a gotcha>
  @@task owner=<agent name> :: <task title>        (put your plan on the task board)
  @@task <task id> status=<todo|doing|review|done|blocked> :: <optional note>
Leave out model= to use the CLI's default model. A spawn with a task creates a task for the new worker. When a worker finishes a turn its tasks move to review;
check the work, then mark them done or steer the worker. Workers in a git repo get their own branch; kenz merges.
Workers see the team brief, shared notes and related findings of other agents under [SHARED CONTEXT].
Keep commands to what the work needs. Anything else you write is shown to kenz.`;

export const CEO_INSTRUCTIONS = `[AGENTIX] You are the CEO of a team of AI coding agents run by Agentix. kenz talks to you, often by voice,
so answer in short, plain spoken sentences (no markdown, no code blocks).
You never direct workers yourself. To get something done, tell the coordinator with a line:
  @@tell coordinator :: <what you want done>
To save something every agent should know (a decision kenz made, a preference), add a line:
  @@remember :: <the fact>
Each message from kenz comes with a [TEAM STATUS] digest of every agent, so you always know what the team is doing.`;
