// Agentix — the team's shared context (a small RAG system).
//
//   $AGENTIX_HOME/context/brief.md     the team brief kenz writes: goals, conventions, what matters
//   $AGENTIX_HOME/context/notes.jsonl  facts any agent saved with "@@remember :: <fact>" (or kenz added)
//
// Before each worker or coordinator turn, the task is used as a query for a BM25 keyword search over the
// notes, the output of every other agent and the text files in settings.contextPaths. The brief and the
// best matches go in front of the prompt as a [SHARED CONTEXT] block, so agents build on each other's work.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent } from '../../shared/src/types.ts';
import { store, AGENTIX_HOME } from './store.ts';
import { getSettings } from './settings.ts';

export interface Note { id: string; ts: number; from: string; text: string }

export interface Hit {
  source: 'note' | 'output' | 'file';
  /** who or where it came from, e.g. "note by Rook", "Nova's output", "/repo/README.md" */
  title: string;
  text: string;
  score: number;
  ts?: number;
  agentId?: string;
  path?: string;
  eventId?: number;
  noteId?: string;
}

const MAX_BRIEF = 20_000;
const MAX_NOTE = 2_000;
const CHUNK = 1_000;
const OUTPUT_EVENTS = 1_000;   // latest agent outputs searched
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEPTH = 8;
const BLOCK_HITS = 5;
const BLOCK_HIT_CHARS = 600;
const BLOCK_BRIEF_CHARS = 3_000;

const dir = () => join(AGENTIX_HOME, 'context');
const briefFile = () => join(dir(), 'brief.md');
const notesFile = () => join(dir(), 'notes.jsonl');

function writeAtomic(file: string, text: string) {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
}

// ---------- brief and notes ----------

export function getBrief(): string {
  try { return readFileSync(briefFile(), 'utf8'); } catch { return ''; }
}

export function setBrief(text: string): string {
  const brief = String(text ?? '').slice(0, MAX_BRIEF);
  writeAtomic(briefFile(), brief);
  return brief;
}

export function listNotes(): Note[] {
  let raw = '';
  try { raw = readFileSync(notesFile(), 'utf8'); } catch { return []; }
  const notes: Note[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const n = JSON.parse(line); if (n?.id && typeof n.text === 'string') notes.push(n); } catch { /* skip a torn line */ }
  }
  return notes;
}

/** Save a fact for the whole team. Returns undefined for an empty note or one that is already saved. */
export function addNote(text: string, from = 'user'): Note | undefined {
  const t = String(text ?? '').trim().slice(0, MAX_NOTE);
  if (!t) return undefined;
  const key = t.toLowerCase();
  if (listNotes().some(n => n.text.toLowerCase() === key)) return undefined;
  const note: Note = { id: 'n_' + randomUUID().slice(0, 8), ts: Date.now(), from, text: t };
  mkdirSync(dir(), { recursive: true });
  appendFileSync(notesFile(), JSON.stringify(note) + '\n');
  return note;
}

export function deleteNote(id: string): boolean {
  const notes = listNotes();
  const rest = notes.filter(n => n.id !== id);
  if (rest.length === notes.length) return false;
  writeAtomic(notesFile(), rest.map(n => JSON.stringify(n) + '\n').join(''));
  return true;
}

// ---------- search ----------

const STOP = new Set(('a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our ' +
  'so that the their them then there these this to us was we were what when where which who why will with you your please ' +
  'should would could just also all any some more most other than too very').split(' '));

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []) {
    if (STOP.has(raw)) continue;
    // a little stemming so "tests"/"test" and "files"/"file" match
    out.push(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Split text into ~CHUNK-character pieces on paragraph, then line, boundaries. */
export function chunk(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length > size) push();
    if (para.length <= size * 1.2) { cur += (cur ? '\n\n' : '') + para; continue; }
    push();
    for (let i = 0; i < para.length; i += size) out.push(para.slice(i, i + size).trim());
  }
  push();
  return out.filter(Boolean);
}

const TEXT_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env.example',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php', '.cs', '.c', '.h',
  '.cpp', '.hpp', '.sh', '.sql', '.css', '.scss', '.html', '.vue', '.svelte', '.lua', '.dart', '.ex', '.exs', '.zig']);
const TEXT_NAMES = new Set(['README', 'LICENSE', 'Makefile', 'Dockerfile', 'AGENTS', 'CLAUDE', 'TODO', 'CHANGELOG']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', '__pycache__', '.venv', 'venv',
  '.cache', 'coverage', '.idea', '.vscode', 'vendor', '.turbo']);

const fileCache = new Map<string, { mtime: number; size: number; chunks: string[] }>();

/** Text files under a folder, newest-first order not needed; capped by count, size and depth. */
function walk(root: string, files: string[], depth = 0) {
  if (files.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (files.length >= MAX_FILES) return;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, files, depth + 1);
    } else if (e.isFile() && (TEXT_EXT.has(extname(e.name).toLowerCase()) || TEXT_NAMES.has(basename(e.name, extname(e.name))))) {
      files.push(p);
    }
  }
}

function fileChunks(path: string): string[] {
  let st;
  try { st = statSync(path); } catch { return []; }
  if (st.size > MAX_FILE_BYTES) return [];
  const cached = fileCache.get(path);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.chunks;
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const chunks = text.includes('\u0000') ? [] : chunk(text);
  fileCache.set(path, { mtime: st.mtimeMs, size: st.size, chunks });
  return chunks;
}

export interface SearchOptions {
  limit?: number;
  /** leave out this agent's own output (it already knows it) */
  excludeAgentId?: string;
  sources?: Hit['source'][];
}

/** BM25 keyword search over notes, agent outputs and indexed files. */
export function searchContext(query: string, opts: SearchOptions = {}): Hit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const sources = new Set(opts.sources ?? ['note', 'output', 'file']);
  const names = new Map(store.getAllAgents().map(a => [a.id, a.name]));
  const docs: Omit<Hit, 'score'>[] = [];

  if (sources.has('note')) {
    for (const n of listNotes()) {
      docs.push({ source: 'note', title: `note by ${n.from === 'user' ? 'kenz' : names.get(n.from) ?? n.from}`, text: n.text, ts: n.ts, noteId: n.id, agentId: n.from });
    }
  }
  if (sources.has('output')) {
    for (const e of store.searchEvents({ types: ['output'], limit: OUTPUT_EVENTS })) {
      if (!e.text || e.agentId === opts.excludeAgentId) continue;
      for (const c of chunk(e.text)) {
        docs.push({ source: 'output', title: `${names.get(e.agentId) ?? e.agentId}'s output`, text: c, ts: e.ts, agentId: e.agentId, eventId: e.id });
      }
    }
  }
  if (sources.has('file')) {
    const files: string[] = [];
    for (const root of getSettings().contextPaths) walk(root, files);
    for (const f of files) for (const c of fileChunks(f)) docs.push({ source: 'file', title: f, text: c, path: f });
  }
  if (!docs.length) return [];

  // BM25 (k1 = 1.2, b = 0.75)
  const toks = docs.map(d => tokenize(d.source === 'file' ? `${basename(d.path!)} ${d.text}` : d.text));
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) if (terms.includes(term)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const hits: Hit[] = [];
  toks.forEach((t, i) => {
    const tf = new Map<string, number>();
    for (const term of t) if (df.has(term)) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const [term, f] of tf) {
      const n = df.get(term)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * t.length / avg));
    }
    // notes are facts agents chose to share: rank them a little higher
    if (score > 0) hits.push({ ...docs[i], score: docs[i].source === 'note' ? score * 1.3 : score });
  });
  hits.sort((a, b) => b.score - a.score || (b.ts ?? 0) - (a.ts ?? 0));

  // one hit per output event or file chunk is enough; avoid repeating the same event's chunks
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    const key = h.eventId != null ? `e${h.eventId}` : h.noteId ?? `${h.path}:${h.text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...h, score: Math.round(h.score * 100) / 100 });
    if (out.length >= (opts.limit ?? 10)) break;
  }
  return out;
}

// ---------- the block in front of a prompt ----------

const clip = (s: string, n: number) => {
  const t = s.replace(/\s*\n\s*/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** The [SHARED CONTEXT] block for an agent's next turn, or '' when shared context is off. */
export function sharedContextBlock(agent: Agent, prompt: string): string {
  if (!getSettings().sharedContext) return '';
  const lines: string[] = ['[SHARED CONTEXT] The team\'s shared memory, from Agentix. Use what helps, ignore the rest.'];
  const brief = getBrief().trim();
  if (brief) lines.push('Team brief:', brief.length > BLOCK_BRIEF_CHARS ? brief.slice(0, BLOCK_BRIEF_CHARS) + '…' : brief);

  let hits = searchContext(prompt, { limit: BLOCK_HITS, excludeAgentId: agent.id });
  if (!hits.some(h => h.source === 'note')) {
    // nothing matched in the notes: still show the latest few, they are usually team-wide facts
    const recent = listNotes().slice(-3).reverse().map(n => ({ source: 'note' as const, title: 'recent note', text: n.text, score: 0 }));
    hits = [...hits.slice(0, BLOCK_HITS - recent.length), ...recent];
  }
  if (hits.length) {
    lines.push('Related notes and findings:');
    hits.forEach((h, i) => lines.push(`${i + 1}. (${h.title}) ${clip(h.text, BLOCK_HIT_CHARS)}`));
  }
  lines.push('To share a fact with every agent, put a line in your reply: @@remember :: <the fact>');
  lines.push('[END SHARED CONTEXT]');
  return lines.join('\n');
}
