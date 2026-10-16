// Agentix — HTTP server with REST + SSE routes
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AgentEvent } from '../../shared/src/types.ts';
import { store } from './store.ts';
import { EventBus } from './bus.ts';
import { SessionManager, HttpError } from './sessions.ts';
import { getAllAdapters } from './adapters/index.ts';
import { getSettings, updateSettings, SettingsError } from './settings.ts';

export const DEFAULT_PORT = Number(process.env.AGENTIX_PORT) || 4317;
export const HOST = '127.0.0.1';
const SSE_DEFAULT_REPLAY = 100;

async function readJson(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new HttpError(413, 'Body too large');
  }
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const WEB_DIST = process.env.AGENTIX_WEB_DIST || fileURLToPath(new URL('../../web/dist/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

/** The built dashboard. Unknown paths get index.html so client-side routes (/agents, ...) work on reload. */
function serveStatic(pathname: string, res: ServerResponse) {
  const index = join(WEB_DIST, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Agentix server is running, but the dashboard is not built. Run: npm install && npm run build\n');
    return;
  }
  let file = normalize(join(WEB_DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || !statSync(file).isFile()) file = index;
  const ext = extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // hashed assets never change; index.html must always be fresh
    'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(readFileSync(file));
}

function writeSSE(res: ServerResponse, e: AgentEvent) {
  res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
}

/**
 * Replay history, then stream live events. Resume point: the Last-Event-ID
 * header or ?after=N; without one, the last ?tail=N (default 100) events.
 */
function serveSSE(req: IncomingMessage, res: ServerResponse, url: URL, bus: EventBus, agentId?: string) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const resume = req.headers['last-event-id'] ?? url.searchParams.get('after');
  const after = resume != null ? Number(resume) || 0 : 0;
  const limit = resume != null ? -1 : Number(url.searchParams.get('tail') ?? SSE_DEFAULT_REPLAY);
  const history = agentId ? store.getAgentEvents(agentId, after, limit) : store.getEvents(after, limit);
  for (const e of history) writeSSE(res, e);

  // No await between replay and subscribe, so no event can slip through the gap.
  const unsubscribe = bus.subscribe(e => {
    if (!agentId || e.agentId === agentId) writeSSE(res, e);
  });
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => { unsubscribe(); clearInterval(keepalive); });
}

export function createAgentixServer(): { server: Server; sessionManager: SessionManager; bus: EventBus } {
  const bus = new EventBus();
  const sm = new SessionManager(bus);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host ?? HOST}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api','agents',id,action]
    const method = req.method;

    // CORS for the Vite dev server (Step 2)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      if (parts[0] !== 'api') {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(url.pathname, res);
      }

      const [, resource, id, action] = parts;

      if (resource === 'adapters' && !id && method === 'GET') {
        const adapters = await Promise.all(getAllAdapters().map(async a => ({ kind: a.kind, ...(await a.detect()) })));
        return sendJson(res, 200, { adapters });
      }

      if (resource === 'stream' && !id && method === 'GET') return serveSSE(req, res, url, bus);

      if (resource === 'events' && !id && method === 'GET') {
        const p = url.searchParams;
        const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 1000);
        const events = store.searchEvents({
          q: p.get('q') || undefined,
          agentId: p.get('agent') || undefined,
          types: p.get('type')?.split(',').filter(Boolean),
          before: Number(p.get('before')) || undefined,
          limit,
        });
        return sendJson(res, 200, { events, stats: store.eventStats() });
      }

      if (resource === 'settings' && !id) {
        if (method === 'GET') return sendJson(res, 200, { settings: getSettings() });
        if (method === 'PUT' || method === 'PATCH') {
          try { return sendJson(res, 200, { settings: updateSettings(await readJson(req)) }); }
          catch (e) { if (e instanceof SettingsError) throw new HttpError(400, e.message); throw e; }
        }
      }

      if (resource === 'coordinator' && id === 'ask' && method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, { event: sm.askCoordinator(b.text, b.about) });
      }

      if (resource === 'agents' && !id) {
        if (method === 'GET') {
          // lastEventId lets a client open /api/stream?after=<it> without replaying what the snapshot already covers.
          const lastEventId = store.getEvents(0, 1)[0]?.id ?? 0;
          return sendJson(res, 200, { agents: sm.getAgents(), lastEventId });
        }
        if (method === 'POST') {
          const b = await readJson(req);
          const agent = sm.createAgent(b.kind, {
            name: b.name, role: b.role, avatarId: b.avatarId, cwd: b.cwd, prompt: b.prompt, replace: b.replace,
          });
          return sendJson(res, 201, { agent });
        }
      }

      if (resource === 'agents' && id && !action) {
        if (method === 'GET') {
          const agent = sm.getAgent(id);
          if (!agent) throw new HttpError(404, `Agent ${id} not found`);
          return sendJson(res, 200, { agent });
        }
        if (method === 'PATCH') return sendJson(res, 200, { agent: sm.updateAgent(id, await readJson(req)) });
        if (method === 'DELETE') { await sm.removeAgent(id); return sendJson(res, 200, { ok: true }); }
      }

      if (resource === 'agents' && id && action) {
        if (action === 'steer' && method === 'POST') {
          const b = await readJson(req);
          return sendJson(res, 200, { event: await sm.steerAgent(id, b.text, b.from) });
        }
        if (action === 'interrupt' && method === 'POST') {
          await sm.interruptAgent(id);
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'events' && method === 'GET') {
          if (!sm.getAgent(id)) throw new HttpError(404, `Agent ${id} not found`);
          const after = Number(url.searchParams.get('after')) || 0;
          return sendJson(res, 200, { events: sm.getAgentEvents(id, after) });
        }
        if (action === 'stream' && method === 'GET') return serveSSE(req, res, url, bus, id);
      }

      throw new HttpError(404, 'Not found');
    } catch (err: any) {
      if (res.headersSent) { res.end(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: err?.message ?? String(err), ...(err?.data ? { data: err.data } : {}) });
    }
  });

  return { server, sessionManager: sm, bus };
}

/** Start listening; resolves once bound, rejects with a readable error (e.g. port in use). */
export function startServer(port = DEFAULT_PORT): Promise<{ server: Server; sessionManager: SessionManager; port: number }> {
  const { server, sessionManager } = createAgentixServer();
  return new Promise((resolve, reject) => {
    server.once('error', (err: any) => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`port ${port} is already in use (another agentix server?). Set AGENTIX_PORT to use a different one.`)
        : err);
    });
    server.listen(port, HOST, () => {
      // Agents that were mid-turn when the server last stopped can't still be running.
      // (Only after binding, so a second server that fails to start can't touch the live one's agents.)
      store.resetBusyAgents();
      const addr = server.address();
      resolve({ server, sessionManager, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}
