// Agentix — HTTP server with REST + SSE routes
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { store } from './store.ts';
import { EventBus } from './bus.ts';
import { SessionManager } from './sessions.ts';
import type { Agent, AgentEvent } from '../shared/src/types.ts';

const PORT = 4317;
const HOST = '127.0.0.1';

const bus = new EventBus();
const sm = new SessionManager(bus);

// JSON parse helper
function parseBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function jsonParse(body: string): any {
  try { return JSON.parse(body); } catch { return {}; }
}

function sendJson(res: any, status: number, data: any) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSSE(res: any, event: string, data: any, id?: number) {
  const line = `id: ${id ?? ''}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(line);
}

function serveSSE(req: any, res: any, agentId?: string) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Handle Last-Event-ID for reconnection
  const lastId = req.headers['last-event-id'];
  const after = lastId ? parseInt(lastId, 10) : 0;

  if (agentId) {
    const events = store.getAgentEvents(agentId, after);
    for (const e of events) {
      sendSSE(res, e.type, e, e.id);
    }
  } else {
    const events = store.getEvents(after);
    for (const e of events) {
      sendSSE(res, e.type, e, e.id);
    }
  }

  const unsubscribe = bus.subscribe((event: AgentEvent) => {
    if (agentId) {
      if (event.agentId === agentId) {
        sendSSE(res, event.type, event, event.id);
      }
    } else {
      sendSSE(res, event.type, event, event.id);
    }
  });

  req.on('close', unsubscribe);

  // Keep alive
  const interval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    } else {
      clearInterval(interval);
    }
  }, 15000);

  req.on('close', () => { clearInterval(interval); });
}

export function createAgentixServer(): { server: Server; sessionManager: SessionManager } {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Routes
      if (path === '/api/adapters' && method === 'GET') {
        const { getAllAdapters } = await import('./adapters/index.ts');
        const adapters = await Promise.all(getAllAdapters().map(async (a) => {
          const det = await a.detect();
          return { kind: a.kind, ...det };
        }));
        sendJson(res, 200, { adapters });
        return;
      }

      if (path === '/api/agents' && method === 'GET') {
        sendJson(res, 200, { agents: sm.getAgents() });
        return;
      }

      if (path === '/api/agents' && method === 'POST') {
        const body = jsonParse(await parseBody(req));
        const agent = sm.createAgent(body.kind, {
          name: body.name,
          role: body.role,
          avatarId: body.avatarId,
          cwd: body.cwd,
          prompt: body.prompt,
        });
        sendJson(res, 201, { agent });
        return;
      }

      if (path.match(/^\/api\/agents\/[^/]+$/) && method === 'PATCH') {
        const id = path.split('/')[3];
        const agent = sm.getAgent(id);
        if (!agent) { sendJson(res, 404, { error: 'Agent not found' }); return; }
        const body = jsonParse(await parseBody(req));
        if (body.name) agent.name = body.name;
        if (body.avatarId !== undefined) agent.avatarId = body.avatarId;
        if (body.role) agent.role = body.role;
        if (body.cwd) agent.cwd = body.cwd;
        store.updateAgent(agent);
        sendJson(res, 200, { agent });
        return;
      }

      if (path.match(/^\/api\/agents\/[^/]+$/) && method === 'DELETE') {
        const id = path.split('/')[3];
        sm.removeAgent(id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path.match(/^\/api\/agents\/[^/]+\/steer$/) && method === 'POST') {
        const id = path.split('/')[3];
        const body = jsonParse(await parseBody(req));
        const event = await sm.steerAgent(id, body.text, body.from);
        sendJson(res, 200, { event });
        return;
      }

      if (path.match(/^\/api\/agents\/[^/]+\/interrupt$/) && method === 'POST') {
        const id = path.split('/')[3];
        await sm.interruptAgent(id);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path.match(/^\/api\/agents\/[^/]+\/events$/) && method === 'GET') {
        const id = path.split('/')[3];
        const after = url.searchParams.get('after');
        const events = sm.getAgentEvents(id, after ? parseInt(after, 10) : undefined);
        sendJson(res, 200, { events });
        return;
      }

      if (path === '/api/stream' && method === 'GET') {
        serveSSE(req, res);
        return;
      }

      if (path.match(/^\/api\/agents\/[^/]+\/stream$/) && method === 'GET') {
        const id = path.split('/')[3];
        serveSSE(req, res, id);
        return;
      }

      // Default: 404
      sendJson(res, 404, { error: 'Not found', path });
    } catch (err: any) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return { server, sessionManager: sm };
}
