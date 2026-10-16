#!/usr/bin/env node
// Agentix CLI — agentix command
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createAgentixServer } from '../../server/src/index.ts';
import { store } from '../../server/src/store.ts';
import { getAdapter, getAdapterNames } from '../../server/src/adapters/index.ts';

const SERVER_URL = 'http://127.0.0.1:4317';

function api(path: string, method = 'GET', body?: any): Promise<any> {
  const { fetch } = globalThis as any;
  const opts: any = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${SERVER_URL}${path}`, opts).then(r => r.json());
}

function getColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = ['\x1b[36m', '\x1b[32m', '\x1b[33m', '\x1b[35m', '\x1b[34m', '\x1b[37m', '\x1b[95m', '\x1b[93m'];
  return colors[Math.abs(hash) % colors.length];
}

const RESET = '\x1b[0m';

async function cmdDoctor() {
  const { execSync } = await import('node:child_process');
  const nodeVer = process.version;

  // Check sqlite
  let sqliteType: string;
  try {
    const sqliteModule = await import('node:sqlite');
    sqliteType = `sqlite (${sqliteModule.Database ? 'native' : 'missing'})`;
  } catch {
    sqliteType = 'json (fallback)';
  }

  console.log(`\n  Agentix Doctor\n${'='.repeat(20)}`);
  console.log(`  Node: ${nodeVer}`);
  console.log(`  Store: ${store.getStoreType()}`);

  // Check adapters
  const adapters = await api('/api/adapters').catch(() => ({ adapters: [] }));
  console.log(`\n  Installed agents:`);
  for (const a of adapters.adapters || []) {
    console.log(`    ${a.kind}: ${a.installed ? `\x1b[32m✓\x1b[0m ${a.version || 'installed'}` : '\x1b[31m✗\x1b[0m not found'}`);
  }
  console.log('');
}

async function cmdServer() {
  const { server, sessionManager } = createAgentixServer();

  server.listen(4317, '127.0.0.1', () => {
    console.log(`\x1b[32m✓\x1b[0m Agentix server running on \x1b[36mhttp://127.0.0.1:4317\x1b[0m`);
    console.log(`\x1b[90m  Store: ${store.getStoreType()}  |  Press Ctrl+C to stop\x1b[0m\n`);
  });

  process.on('SIGINT', () => {
    console.log('\n\x1b[90mShutting down...\x1b[0m');
    server.close(() => process.exit(0));
  });
}

async function cmdSpawn(args: string[]) {
  let kind = '', role = 'worker', avatarId: number | 'random' = 0, cwd = '.', prompt = '';
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--role' && args[i + 1]) { role = args[i + 1]; i += 2; continue; }
    if (arg === '--avatar' && args[i + 1]) { avatarId = args[i + 1] === 'random' ? 'random' : parseInt(args[i + 1], 10); i += 2; continue; }
    if (arg === '--cwd' && args[i + 1]) { cwd = args[i + 1]; i += 2; continue; }
    if (!kind && getAdapterNames().includes(arg)) { kind = arg; i++; continue; }
    if (!prompt) { prompt += (prompt ? ' ' : '') + arg; i++; continue; }
    i++;
  }

  if (!kind) {
    console.error('Usage: agentix spawn <kind> [--role worker|coordinator|ceo] [--avatar 0-9|random] [--cwd <dir>] "<prompt>"');
    console.error(`Available kinds: ${getAdapterNames().join(', ')}`);
    process.exit(1);
  }

  const result = await api('/api/agents', 'POST', { kind, role, avatarId, cwd, prompt });
  const a = result.agent;
  const color = getColor(a.id);
  console.log(`${color}✓ Spawned agent ${a.id} (${a.name})\x1b[0m`);
  console.log(`  kind: ${a.kind}  |  role: ${a.role}  |  avatar: ${a.avatarId}  |  status: ${a.status}`);
  if (a.prompt) console.log(`  prompt: ${a.prompt}`);
  console.log('');
}

async function cmdLs() {
  const result = await api('/api/agents');
  const agents = result.agents || [];

  if (agents.length === 0) {
    console.log('\x1b[90mNo agents.\x1b[0m');
    return;
  }

  const header = `\x1b[1m${'ID'.padEnd(8)} ${'NAME'.padEnd(10)} ${'KIND'.padEnd(10)} ${'ROLE'.padEnd(12)} ${'STATUS'.padEnd(14)} ACTIVITY\x1b[0m`;
  console.log(header);
  console.log('─'.repeat(80));

  for (const a of agents) {
    const color = getColor(a.id);
    console.log(`${color}${a.id.padEnd(8)} ${a.name.padEnd(10)} ${a.kind.padEnd(10)} ${a.role.padEnd(12)} ${a.status.padEnd(14)} ${a.activity}\x1b[0m`);
  }
  console.log('');
}

async function cmdLogs(agentId: string, follow = false) {
  let lastId = 0;

  async function fetchEvents() {
    const result = await api(`/api/agents/${agentId}/events?after=${lastId}`);
    const events = result.events || [];
    for (const e of events) {
      lastId = e.id;
      const color = getColor(e.agentId);
      const ts = new Date(e.ts).toLocaleTimeString();
      console.log(`${color}${ts}\x1b[0m [${e.agentId}] ${e.type}: ${e.text || ''}`);
    }
    return events.length;
  }

  let count = await fetchEvents();
  if (!follow || count > 0) return;

  console.log(`\x1b[90mFollowing events for ${agentId}... (Ctrl+C to stop)\x1b[0m\n`);

  const interval = setInterval(async () => {
    const c = await fetchEvents();
    if (c === 0) {
      clearInterval(interval);
      console.log('\x1b[90mNo more events.\x1b[0m');
    }
  }, 1000);

  process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
}

async function cmdSteer(agentId: string, text: string) {
  const result = await api(`/api/agents/${agentId}/steer`, 'POST', { text });
  const color = getColor(agentId);
  console.log(`${color}✓ Steered ${agentId}\x1b[0m: "${text}"`);
  console.log('');
}

async function cmdStop(agentId: string) {
  await api(`/api/agents/${agentId}/interrupt`, 'POST');
  const color = getColor(agentId);
  console.log(`${color}✓ Stopped ${agentId}\x1b[0m`);
  console.log('');
}

async function cmdRm(agentId: string) {
  await api(`/api/agents/${agentId}`, 'DELETE');
  const color = getColor(agentId);
  console.log(`${color}✓ Removed ${agentId}\x1b[0m`);
  console.log('');
}

async function cmdWatch() {
  console.log('\x1b[90mWatching all agents... (Ctrl+C to stop)\x1b[0m\n');

  const es = new EventSource(`${SERVER_URL}/api/stream`);

  es.onmessage = (event: any) => {
    try {
      const data = JSON.parse(event.data);
      const color = getColor(data.agentId);
      const ts = new Date(data.ts).toLocaleTimeString();
      console.log(`${color}${ts}\x1b[0m [${data.agentId}] ${data.type}: ${data.text || ''}`);
    } catch { /* ignore parse errors */ }
  };

  es.onerror = () => {
    console.error('\x1b[31mConnection lost. Reconnecting...\x1b[0m');
  };

  process.on('SIGINT', () => { es.close(); process.exit(0); });
}

// Main CLI entry
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    console.log(`\x1b[1mAgentix\x1b[0m — AI agent orchestration\n`);
    console.log('  Usage:');
    console.log('    agentix server                         Start the server');
    console.log('    agentix doctor                         Check environment');
    console.log('    agentix spawn <kind> [opts] "<prompt>"  Spawn an agent');
    console.log('    agentix ls                             List agents');
    console.log('    agentix logs <id> [-f]                 Show events');
    console.log('    agentix steer <id> "<text>"            Steer an agent');
    console.log('    agentix stop <id>                      Stop an agent');
    console.log('    agentix rm <id>                        Remove an agent');
    console.log('    agentix watch                          Live feed');
    console.log('');
    return;
  }

  switch (cmd) {
    case 'server': await cmdServer(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'spawn': await cmdSpawn(args.slice(1)); break;
    case 'ls': await cmdLs(); break;
    case 'logs': await cmdLogs(args[1], args.includes('-f')); break;
    case 'steer': await cmdSteer(args[1], args.slice(2).join(' ')); break;
    case 'stop': await cmdStop(args[1]); break;
    case 'rm': await cmdRm(args[1]); break;
    case 'watch': await cmdWatch(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
