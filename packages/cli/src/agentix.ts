#!/usr/bin/env node
// Agentix CLI — agentix command. Talks to the server over HTTP/SSE only
// (`server` and `doctor` are the exceptions: they run/inspect things locally).
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const PORT = Number(process.env.AGENTIX_PORT) || 4317;
const SERVER_URL = process.env.AGENTIX_URL || `http://127.0.0.1:${PORT}`;

const RESET = '\x1b[0m';
const DIM = '\x1b[90m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const COLORS = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[95m', '\x1b[93m', '\x1b[96m'];

function color(id = ''): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

class CliError extends Error {}

async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(`can't reach the agentix server at ${SERVER_URL}. Start it with: agentix server`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(data.error || `${method} ${path} failed with ${res.status}`);
  return data;
}

// ---------- SSE client (Node has no EventSource) ----------

interface SSEMessage { id?: string; event: string; data: string }

/** Read one SSE connection until it ends. Handles named events, ids and comments. */
async function readSSE(url: string, lastId: string | undefined, onMessage: (m: SSEMessage) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
    signal,
  });
  if (!res.ok || !res.body) throw new CliError(`stream failed: ${res.status}`);
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const msg: SSEMessage = { event: 'message', data: '' };
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'id') msg.id = value;
        else if (field === 'event') msg.event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) continue;
      msg.data = data.join('\n');
      onMessage(msg);
    }
  }
}

/** Follow a stream forever, reconnecting with Last-Event-ID. */
async function followSSE(url: string, onEvent: (e: any) => void): Promise<never> {
  let lastId: string | undefined;
  let warned = false;
  for (;;) {
    try {
      await readSSE(url, lastId, m => {
        if (m.id) lastId = m.id;
        try { onEvent(JSON.parse(m.data)); } catch { /* not JSON */ }
      });
      warned = false;
    } catch (err: any) {
      if (!warned) console.error(`${RED}stream disconnected (${err?.message ?? err}); retrying…${RESET}`);
      warned = true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ---------- formatting ----------

const names = new Map<string, string>();

function formatEvent(e: any): string {
  const ts = new Date(e.ts).toLocaleTimeString();
  const who = names.get(e.agentId) ? `${names.get(e.agentId)} ${e.agentId}` : e.agentId;
  const from = e.from && e.from !== 'user' && e.from !== e.agentId ? ` ${DIM}from ${names.get(e.from) ?? e.from}${RESET}` : '';
  const text = e.type === 'status' ? `${e.data?.status ?? e.text} ${DIM}${e.data?.activity ?? ''}${RESET}` : (e.text ?? '');
  return `${color(e.agentId)}${ts} [${who}]${RESET} ${e.type}${from}: ${text}`;
}

function trackNames(e: any) {
  if ((e.type === 'agent.created' || e.type === 'agent.updated') && e.data?.name) names.set(e.agentId, e.data.name);
}

async function loadNames() {
  try {
    for (const a of (await api('/api/agents')).agents) names.set(a.id, a.name);
  } catch { /* server down: followSSE will say so */ }
}

// ---------- commands ----------

async function cmdServer() {
  const { startServer } = await import('../../server/src/index.ts');
  const { store } = await import('../../server/src/store.ts');
  const { server, sessionManager, port } = await startServer(PORT);
  console.log(`${GREEN}✓${RESET} Agentix server running on \x1b[36mhttp://127.0.0.1:${port}${RESET}`);
  console.log(`${DIM}  Store: ${store.getStoreType()}  |  Press Ctrl+C to stop${RESET}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${DIM}Stopping agents and shutting down…${RESET}`);
    await sessionManager.shutdown();
    server.close();
    server.closeAllConnections?.();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdDoctor() {
  const { getAllAdapters } = await import('../../server/src/adapters/index.ts');
  let sqlite = false;
  try { sqlite = !!(process as any).getBuiltinModule('node:sqlite')?.DatabaseSync; } catch { /* old node */ }

  console.log(`\n  Agentix Doctor\n  ${'='.repeat(20)}`);
  console.log(`  Node:   ${process.version}`);
  console.log(`  Store:  ${sqlite ? 'sqlite' : 'json (node:sqlite unavailable)'}${process.env.AGENTIX_STORE === 'json' ? ' — forced to json by AGENTIX_STORE' : ''}`);
  let serverUp = false;
  try { await api('/api/agents'); serverUp = true; } catch { /* down */ }
  console.log(`  Server: ${serverUp ? `${GREEN}up${RESET} at ${SERVER_URL}` : `${DIM}not running (${SERVER_URL})${RESET}`}`);

  console.log(`\n  Agent CLIs:`);
  for (const a of getAllAdapters()) {
    const d = await a.detect();
    console.log(`    ${a.kind.padEnd(9)} ${d.installed ? `${GREEN}✓${RESET} ${d.version ?? ''}` : `${RED}✗${RESET} not found`}`);
  }
  console.log('');
}

async function cmdSpawn(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      role: { type: 'string', default: 'worker' },
      avatar: { type: 'string', default: 'random' },
      cwd: { type: 'string' },
      name: { type: 'string' },
      replace: { type: 'boolean', default: false },
    },
  });
  const [kind, ...rest] = positionals;
  if (!kind) {
    throw new CliError('usage: agentix spawn <kind> [--role worker|coordinator|ceo] [--avatar 0-9|random] [--name N] [--cwd DIR] [--replace] "<prompt>"');
  }
  const avatarId = values.avatar === 'random' ? 'random' : Number(values.avatar);
  const { agent: a } = await api('/api/agents', 'POST', {
    kind,
    role: values.role,
    avatarId,
    name: values.name,
    cwd: values.cwd ? resolve(values.cwd) : undefined,
    prompt: rest.join(' ') || undefined,
    replace: values.replace,
  });
  console.log(`${color(a.id)}✓ Spawned ${a.name} (${a.id})${RESET}`);
  console.log(`  kind: ${a.kind}  |  role: ${a.role}  |  avatar: ${a.avatarId}  |  status: ${a.status}  |  cwd: ${a.cwd}\n`);
}

async function cmdLs() {
  const { agents } = await api('/api/agents');
  if (!agents.length) { console.log(`${DIM}No agents.${RESET}`); return; }
  console.log(`\x1b[1m${'ID'.padEnd(9)} ${'NAME'.padEnd(8)} ${'KIND'.padEnd(9)} ${'ROLE'.padEnd(12)} ${'STATUS'.padEnd(9)} ACTIVITY${RESET}`);
  console.log('─'.repeat(80));
  for (const a of agents) {
    console.log(`${color(a.id)}${a.id.padEnd(9)} ${a.name.padEnd(8)} ${a.kind.padEnd(9)} ${a.role.padEnd(12)} ${a.status.padEnd(9)} ${a.activity}${RESET}`);
  }
  console.log('');
}

async function cmdLogs(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { follow: { type: 'boolean', short: 'f', default: false } } });
  const id = positionals[0];
  if (!id) throw new CliError('usage: agentix logs <id> [-f]');
  const { agent } = await api(`/api/agents/${encodeURIComponent(id)}`);
  names.set(agent.id, agent.name);
  if (!values.follow) {
    for (const e of (await api(`/api/agents/${encodeURIComponent(id)}/events`)).events) console.log(formatEvent(e));
    return;
  }
  console.log(`${DIM}Following ${agent.name} (${id})… Ctrl+C to stop${RESET}\n`);
  await followSSE(`${SERVER_URL}/api/agents/${encodeURIComponent(id)}/stream?after=0`, e => { trackNames(e); console.log(formatEvent(e)); });
}

async function cmdWatch() {
  await loadNames();
  console.log(`${DIM}Watching all agents… Ctrl+C to stop${RESET}\n`);
  await followSSE(`${SERVER_URL}/api/stream?tail=20`, e => { trackNames(e); console.log(formatEvent(e)); });
}

async function needId(args: string[], usage: string): Promise<string> {
  if (!args[0]) throw new CliError(`usage: ${usage}`);
  return encodeURIComponent(args[0]);
}

const HELP = `\x1b[1mAgentix\x1b[0m — AI agent orchestration

  Usage:
    agentix server                          Start the server (AGENTIX_PORT, default 4317)
    agentix doctor                          Check node, store and installed agent CLIs
    agentix spawn <kind> [opts] "<prompt>"  Spawn an agent (kinds: mock, codex, opencode, claude)
        --role worker|coordinator|ceo  --avatar 0-9|random  --name N  --cwd DIR  --replace
    agentix ls                              List agents
    agentix logs <id> [-f]                  Show (or follow) an agent's events
    agentix steer <id> "<text>"             Interrupt if busy, then continue the session with <text>
    agentix stop <id>                       Stop the current turn
    agentix rm <id>                         Stop and remove an agent
    agentix watch                           Live feed of all agents
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); return;
    case 'server': return cmdServer();
    case 'doctor': return cmdDoctor();
    case 'spawn': return cmdSpawn(args);
    case 'ls': return cmdLs();
    case 'logs': return cmdLogs(args);
    case 'watch': return cmdWatch();
    case 'steer': {
      const id = await needId(args, 'agentix steer <id> "<text>"');
      const text = args.slice(1).join(' ');
      if (!text) throw new CliError('usage: agentix steer <id> "<text>"');
      await api(`/api/agents/${id}/steer`, 'POST', { text });
      console.log(`${color(args[0])}✓ Steered ${args[0]}${RESET}: "${text}"`);
      return;
    }
    case 'stop': {
      const id = await needId(args, 'agentix stop <id>');
      await api(`/api/agents/${id}/interrupt`, 'POST');
      console.log(`${color(args[0])}✓ Stopped ${args[0]}${RESET}`);
      return;
    }
    case 'rm': {
      const id = await needId(args, 'agentix rm <id>');
      await api(`/api/agents/${id}`, 'DELETE');
      console.log(`${color(args[0])}✓ Removed ${args[0]}${RESET}`);
      return;
    }
    default:
      throw new CliError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch(err => {
  console.error(`${RED}Error:${RESET} ${err?.message ?? err}`);
  process.exit(1);
});
