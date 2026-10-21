// Agentix — HTTP server with REST + SSE routes
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, relative, extname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AgentEvent } from '../../shared/src/types.ts';
import { store } from './store.ts';
import { EventBus } from './bus.ts';
import { SessionManager, HttpError, cleanModel } from './sessions.ts';
import { getAllAdapters, getAdapter } from './adapters/index.ts';
import { listModels, unavailableModelError } from './adapters/models.ts';
import { getSettings, updateSettings, SettingsError } from './settings.ts';
import { getBrief, setBrief, listNotes, addNote, deleteNote, clearSharedContext, searchContextSmart, embed, lastEmbeddingError } from './context.ts';
import { listTasks, clearTasks } from './tasks.ts';
import { pruneOldEvents } from './retention.ts';
import { scanClis } from './setup.ts';
import { historyDir } from './history.ts';
import { AGENTIX_HOME } from './store.ts';

export const DEFAULT_PORT = Number(process.env.AGENTIX_PORT) || 4317;
export const HOST = '127.0.0.1';
const SSE_DEFAULT_REPLAY = 100;

async function requireAvailableModel(kind: string, value: unknown): Promise<string | undefined> {
  const model = cleanModel(value);
  if (!model) return undefined;
  const error = await unavailableModelError(kind, model);
  if (error) throw new HttpError(400, error);
  return model;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new HttpError(413, 'Body too large');
  }
  if (!body.trim()) return {};
  try { return JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Host header names this machine (a missing header is allowed: HTTP/1.0 clients, curl --http1.0). */
export function isLocalHost(host: string | undefined): boolean {
  return !host || LOCAL_HOST.test(host);
}

/**
 * The origins allowed to drive the API besides the server's own: the Vite dev server, which proxies
 * /api to us, and anything else the user lists in AGENTIX_DEV_ORIGINS (comma separated).
 * A dev server on another port (Vite moves to the next free one) has to be added here.
 */
const DEV_ORIGINS = (process.env.AGENTIX_DEV_ORIGINS
  ?? 'http://localhost:5173,http://127.0.0.1:5173,http://[::1]:5173')
  .split(',').map(o => o.trim().toLowerCase()).filter(Boolean);

/**
 * Browsers send Origin on cross-site requests; it must be our own page.
 *
 * "Is it local?" is the wrong question: any other app on this machine (a dev server on :3000, a
 * browser extension page) is a different site and must not be able to create agents, set CLI paths
 * or steer them. So the Origin has to match the host the request was made to, or be a dev origin
 * we know about. No Origin at all means a non-browser client (the CLI, curl) on this machine.
 */
export function isLocalOrigin(origin: string | undefined, host?: string): boolean {
  if (!origin) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const key = `${u.protocol}//${u.host}`.toLowerCase();
  if (host) {
    // The dashboard this server serves: same host and port the request came in on.
    if (key === `http://${host.toLowerCase()}`) return true;
  }
  return DEV_ORIGINS.includes(key);
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const WEB_DIST = resolve(process.env.AGENTIX_WEB_DIST || fileURLToPath(new URL('../../web/dist/', import.meta.url)));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

function decodePathPart(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes('\u0000')) throw new Error('NUL byte');
    return decoded;
  } catch {
    throw new HttpError(400, 'Malformed URL encoding');
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The built dashboard. Unknown paths get index.html so client-side routes (/agents, ...) work on reload. */
function serveStatic(pathname: string, res: ServerResponse) {
  const index = join(WEB_DIST, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Agentix server is running, but the dashboard is not built. Run: npm install && npm run build\n');
    return;
  }
  let file = resolve(WEB_DIST, `.${decodePathPart(pathname)}`);
  if (!isWithin(WEB_DIST, file) || !existsSync(file) || !statSync(file).isFile()) {
    file = index;
  } else {
    // A symlink inside the dashboard must not expose a file outside its root.
    try {
      if (!isWithin(realpathSync(WEB_DIST), realpathSync(file))) file = index;
    } catch {
      file = index;
    }
  }
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
    const method = req.method;

    // Only this machine may talk to the server. A Host check blocks DNS rebinding, and an Origin check stops
    // any other website open in the browser from creating or steering agents (no CORS headers are sent).
    if (!isLocalHost(req.headers.host)) return sendJson(res, 403, { error: 'Forbidden host' });
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (isApi && !isLocalOrigin(req.headers.origin, req.headers.host)) return sendJson(res, 403, { error: 'Forbidden origin' });
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      const parts = url.pathname.split('/').filter(Boolean).map(decodePathPart); // ['api','agents',id,action]
      if (parts[0] !== 'api') {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(url.pathname, res);
      }

      const [, resource, id, action, sub] = parts;

      if (resource === 'adapters' && id && action === 'models' && method === 'GET') {
        if (!getAdapter(id)) throw new HttpError(404, `Unknown agent kind: ${id}`);
        return sendJson(res, 200, await listModels(id, url.searchParams.get('refresh') === '1'));
      }

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

      if (resource === 'reset' && !id && method === 'POST') {
        await sm.resetWorkspace();
        clearTasks();
        clearSharedContext();
        const settings = updateSettings({ setupDone: false, contextPaths: [] });
        return sendJson(res, 200, { ok: true, settings });
      }

      if (resource === 'context') {
        if (!id && method === 'GET') {
          return sendJson(res, 200, {
            brief: getBrief(), notes: listNotes(), contextPaths: getSettings().contextPaths,
            sharedContext: getSettings().sharedContext, dir: join(AGENTIX_HOME, 'context'),
          });
        }
        if (id === 'brief' && method === 'PUT') return sendJson(res, 200, { brief: setBrief((await readJson(req)).text ?? '') });
        if (id === 'notes' && !action && method === 'POST') {
          const b = await readJson(req);
          if (!String(b.text ?? '').trim()) throw new HttpError(400, 'text is required');
          return sendJson(res, 201, { note: addNote(b.text, 'user') ?? null });
        }
        if (id === 'notes' && action && method === 'DELETE') {
          if (!deleteNote(action)) throw new HttpError(404, `Note ${action} not found`);
          return sendJson(res, 200, { ok: true });
        }
        if (id === 'search' && method === 'GET') {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50);
          const hits = await searchContextSmart(url.searchParams.get('q') ?? '', { limit });
          return sendJson(res, 200, { hits, embeddingError: lastEmbeddingError || undefined });
        }
        if (id === 'embeddings' && action === 'test' && method === 'POST') {
          try {
            const [v] = await embed(['Agentix embedding test']);
            return sendJson(res, 200, { ok: true, dimensions: v.length });
          } catch (e: any) { return sendJson(res, 200, { ok: false, error: e?.message ?? String(e) }); }
        }
      }

      if (resource === 'setup' && id === 'scan' && method === 'GET') return sendJson(res, 200, await scanClis());

      if (resource === 'usage' && !id && method === 'GET') {
        const day = new Date(); day.setHours(0, 0, 0, 0);
        return sendJson(res, 200, { total: store.usageTotals(), today: store.usageTotals(day.getTime()) });
      }

      if (resource === 'tasks') {
        if (!id && method === 'GET') return sendJson(res, 200, { tasks: listTasks() });
        if (!id && method === 'POST') return sendJson(res, 201, { task: sm.addTask(await readJson(req)) });
        if (id && !action && method === 'PATCH') return sendJson(res, 200, { task: sm.editTask(id, await readJson(req)) });
        if (id && !action && method === 'DELETE') { sm.removeTask(id); return sendJson(res, 200, { ok: true }); }
      }

      if (resource === 'coordinator' && id === 'ask' && method === 'POST') {
        const b = await readJson(req);
        return sendJson(res, 200, { event: sm.askCoordinator(b.text, b.about) });
      }

      if (resource === 'agents' && !id) {
        if (method === 'GET') {
          // lastEventId lets a client open /api/stream?after=<it> without replaying what the snapshot already covers.
          const lastEventId = store.getEvents(0, 1)[0]?.id ?? 0;
          // ?archived=1 adds removed agents (they have archivedAt), whose history is kept.
          const agents = url.searchParams.get('archived') === '1' ? sm.getAllAgents() : sm.getAgents();
          return sendJson(res, 200, { agents, lastEventId, historyDir: historyDir(AGENTIX_HOME) });
        }
        if (method === 'POST') {
          const b = await readJson(req);
          const model = await requireAvailableModel(b.kind, b.model);
          const agent = sm.createAgent(b.kind, {
            name: b.name, role: b.role, avatarId: b.avatarId, cwd: b.cwd, prompt: b.prompt, replace: b.replace, model,
            ...(typeof b.worktree === 'boolean' ? { worktree: b.worktree } : {}),
          });
          return sendJson(res, 201, { agent });
        }
      }

      if (resource === 'agents' && id && !action) {
        if (method === 'GET') {
          const agent = sm.getAgent(id, url.searchParams.get('archived') === '1');
          if (!agent) throw new HttpError(404, `Agent ${id} not found`);
          return sendJson(res, 200, { agent });
        }
        if (method === 'PATCH') {
          const b = await readJson(req);
          if (Object.prototype.hasOwnProperty.call(b, 'model')) {
            const existing = sm.getAgent(id);
            if (!existing) throw new HttpError(404, `Agent ${id} not found`);
            b.model = (await requireAvailableModel(existing.kind, b.model)) ?? null;
          }
          return sendJson(res, 200, { agent: sm.updateAgent(id, b) });
        }
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
        if (action === 'worktree') {
          if (!sub && method === 'GET') return sendJson(res, 200, sm.getWorktree(id));
          if (sub === 'merge' && method === 'POST') return sendJson(res, 200, sm.mergeWorktree(id));
          if (sub === 'discard' && method === 'POST') { sm.discardWorktree(id); return sendJson(res, 200, { ok: true }); }
        }
        if (action === 'session' && method === 'POST') {
          const b = await readJson(req);
          return sendJson(res, 200, { event: await sm.newSession(id, Boolean(b.clear)) });
        }
        if (action === 'events' && method === 'GET') {
          if (!sm.getAgent(id, true)) throw new HttpError(404, `Agent ${id} not found`);
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
      // Old events leave the database now and every 6 hours (the history files keep them).
      pruneOldEvents();
      const prune = setInterval(pruneOldEvents, 6 * 3600_000);
      prune.unref();
      server.once('close', () => clearInterval(prune));
      const addr = server.address();
      resolve({ server, sessionManager, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}
