// The team's shared context: the brief, saved notes, folders to search, and a search box to see what agents get.
import { useEffect, useState } from 'react';
import { api, type ContextHit, type ContextInfo } from '../api.ts';
import { useStore } from '../store.ts';

const SOURCE_LABEL: Record<ContextHit['source'], string> = { note: 'note', output: 'agent output', file: 'file' };

export function Context() {
  const live = useStore(s => s.agents);
  const archived = useStore(s => s.archived);
  const setServerSettings = useStore(s => s.setServerSettings);
  const server = useStore(s => s.server);
  const lastEventId = useStore(s => s.lastEventId);
  const [info, setInfo] = useState<ContextInfo>();
  const [brief, setBrief] = useState('');
  const [note, setNote] = useState('');
  const [folder, setFolder] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ContextHit[]>();
  const [semantic, setSemantic] = useState<string>();
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const load = () => api.context().then(i => { setInfo(i); return i; }).catch(e => { setError(String(e.message ?? e)); return undefined; });
  useEffect(() => { load().then(i => i && setBrief(i.brief)); }, []);
  // New @@remember notes arrive as agent events; refresh the list now and then.
  useEffect(() => { const t = setTimeout(load, 400); return () => clearTimeout(t); }, [Math.floor(lastEventId / 10)]);

  useEffect(() => {
    if (!q.trim()) { setHits(undefined); return; }
    const t = setTimeout(() => api.searchContext(q).then(r => { setHits(r.hits); setSemantic(r.embeddingError); }).catch(e => setError(String(e.message ?? e))), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function act(fn: () => Promise<unknown>, what?: string) {
    setError(''); setSaved('');
    try { await fn(); if (what) setSaved(what); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const saveFolders = (paths: string[]) => act(async () => setServerSettings(await api.saveSettings({ contextPaths: paths })), 'folders');
  const who = (from: string) => from === 'user' ? 'you' : live[from]?.name ?? archived[from]?.name ?? from;

  if (!info) return <div className="page"><h1>Shared context</h1><p className="muted">{error || 'Loading…'}</p></div>;

  return (
    <div className="page context">
      <h1>Shared context</h1>
      <p className="muted lead">
        Before each task, workers and the coordinator get the team brief plus the notes, agent findings and files that best match the task.
        Any agent can add a note by writing <span className="mono">@@remember :: &lt;fact&gt;</span> on its own line.
      </p>
      {error && <div className="error">{error}</div>}
      {saved && <div className="saved">Saved {saved}.</div>}

      <section className="card">
        <div className="row">
          <h2 className="grow">Team brief</h2>
          <label className="check">
            <input type="checkbox" checked={info.sharedContext}
              onChange={e => act(async () => setServerSettings(await api.saveSettings({ sharedContext: e.target.checked })), 'shared context setting')} />
            give agents the shared context
          </label>
        </div>
        <textarea className="brief" rows={6} value={brief} onChange={e => setBrief(e.target.value)}
          placeholder="What is the team working on? Goals, conventions, where things live, what to avoid…" />
        <div className="row end">
          <span className="muted small grow mono">{info.dir}</span>
          <button className="btn primary" disabled={brief === info.brief} onClick={() => act(() => api.saveBrief(brief), 'the brief')}>Save brief</button>
        </div>
      </section>

      <section className="card">
        <h2>Notes <span className="muted small">{info.notes.length}</span></h2>
        <form className="row" onSubmit={e => { e.preventDefault(); const t = note.trim(); if (t) act(() => api.addNote(t).then(() => setNote('')), 'the note'); }}>
          <input className="grow" value={note} onChange={e => setNote(e.target.value)} placeholder="Add a fact every agent should know…" />
          <button className="btn" disabled={!note.trim()}>Add</button>
        </form>
        <div className="notes">
          {info.notes.length === 0 && <div className="muted small pad">No notes yet.</div>}
          {[...info.notes].reverse().map(n => (
            <div key={n.id} className="note">
              <div className="grow">
                <div className="note-text">{n.text}</div>
                <div className="muted small">{who(n.from)} · {new Date(n.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
              </div>
              <button className="icon-btn" title="Delete note" onClick={() => act(() => api.deleteNote(n.id))}>✕</button>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Folders to search</h2>
        <p className="muted small">Text files in these folders (docs, notes, a repo) are searched too. node_modules, .git and build output are skipped.</p>
        {info.contextPaths.map(p => (
          <div key={p} className="row folder">
            <span className="mono grow">{p}</span>
            <button className="btn small danger" onClick={() => saveFolders(info.contextPaths.filter(x => x !== p))}>Remove</button>
          </div>
        ))}
        <form className="row" onSubmit={e => { e.preventDefault(); const f = folder.trim(); if (f) saveFolders([...info.contextPaths, f]).then(() => setFolder('')); }}>
          <input className="grow mono" value={folder} onChange={e => setFolder(e.target.value)} placeholder="/home/you/projects/app/docs" />
          <button className="btn" disabled={!folder.trim()}>Add folder</button>
        </form>
      </section>

      <section className="card">
        <div className="row">
          <h2 className="grow">Search</h2>
          <span className={`pill ${server?.embeddings.provider === 'ollama' && !semantic ? 'pill-ok' : ''}`}
            title={semantic ?? (server?.embeddings.provider === 'ollama' ? `Keyword + meaning search with ${server.embeddings.model}` : 'Turn on meaning search in Settings')}>
            {server?.embeddings.provider === 'ollama' ? (semantic ? 'keywords only: embeddings failed' : 'keywords + meaning') : 'keywords'}
          </span>
        </div>
        {semantic && <p className="muted small">{semantic}</p>}
        <input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Try a task, e.g. “deploy to staging”: this is what an agent would be shown" />
        <div className="hits">
          {hits?.length === 0 && <div className="muted small pad">Nothing matches.</div>}
          {hits?.map((h, i) => (
            <div key={i} className={`hit hit-${h.source}`}>
              <div className="hit-meta"><span className="hit-src">{SOURCE_LABEL[h.source]}</span><span className="mono">{h.source === 'note' ? h.title : h.source === 'output' ? who(h.agentId ?? '') : h.title}</span><span className="muted">score {h.score}</span></div>
              <div className="hit-text">{h.text}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
