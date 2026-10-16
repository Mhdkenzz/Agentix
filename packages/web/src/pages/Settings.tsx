// Server settings (coordinator mode, defaults, CLI paths) and this browser's voice preferences.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type AdapterInfo, type CoordinatorMode, type ServerSettings } from '../api.ts';
import { useStore } from '../store.ts';
import { loadSettings, saveSettings } from '../settings.ts';
import { canListen, canSpeak, speak } from '../voice.ts';

const MODES: { id: CoordinatorMode; title: string; text: string }[] = [
  { id: 'human', title: 'You coordinate', text: 'You direct every agent. A coordinator agent, if there is one, gets no updates and its commands are ignored.' },
  { id: 'agent', title: 'Agent coordinates', text: 'The coordinator agent directs the workers. What you type in a worker’s panel goes to the coordinator.' },
  { id: 'both', title: 'You + agent', text: 'The coordinator directs and is told about everything, and you can still steer anyone directly.' },
];

export function Settings() {
  const server = useStore(s => s.server);
  const setServerSettings = useStore(s => s.setServerSettings);
  const navigate = useNavigate();
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [local, setLocal] = useState(loadSettings);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [emb, setEmb] = useState<ServerSettings['embeddings']>();
  const [embTest, setEmbTest] = useState<string>();
  const [resetBusy, setResetBusy] = useState(false);

  const detect = () => api.adapters().then(setAdapters).catch(e => setError(String(e.message ?? e)));
  useEffect(() => { detect(); }, []);
  // Take the saved paths once; later saves of other settings must not wipe what's being typed.
  const pathsLoaded = useRef(false);
  useEffect(() => { if (server && !pathsLoaded.current) { pathsLoaded.current = true; setPaths(server.cliPaths); setEmb(server.embeddings); } }, [server]);
  useEffect(() => {
    if (!canSpeak) return;
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  async function save(patch: Partial<ServerSettings>, what: string) {
    setError(''); setSaved('');
    try { setServerSettings(await api.saveSettings(patch)); setSaved(what); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  function saveLocal(next: typeof local) { setLocal(next); saveSettings(next); }

  async function startFresh() {
    if (!window.confirm('Start fresh? This stops all agents and permanently removes agents, tasks, shared context, usage, and history. Your CLI settings are kept.')) return;
    setResetBusy(true); setError('');
    try {
      await api.resetWorkspace();
      window.location.assign('/setup');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResetBusy(false);
    }
  }

  if (!server) return <div className="page"><h1>Settings</h1><p className="muted">Connecting to the server…</p></div>;

  return (
    <div className="page settings">
      <h1>Settings</h1>
      {error && <div className="error">{error}</div>}
      {saved && <div className="saved">Saved {saved}.</div>}

      <section className="card">
        <h2>Who coordinates</h2>
        <div className="mode-cards">
          {MODES.map(m => (
            <button key={m.id} className={`mode-card ${server.coordinatorMode === m.id ? 'on' : ''}`} onClick={() => save({ coordinatorMode: m.id }, 'coordinator mode')}>
              <b>{m.title}</b><span className="muted small">{m.text}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>New agents</h2>
        <div className="grid2">
          <label>Default agent
            <select value={server.defaultKind} onChange={e => save({ defaultKind: e.target.value }, 'default agent')}>
              {adapters.map(a => <option key={a.kind} value={a.kind}>{a.kind}{a.installed ? '' : ' (not installed)'}</option>)}
            </select>
          </label>
          <label>Default working folder
            <input defaultValue={server.defaultCwd} placeholder="~/.agentix/workspace" key={server.defaultCwd}
              onBlur={e => e.target.value.trim() !== server.defaultCwd && save({ defaultCwd: e.target.value }, 'default folder')} />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Workers and history</h2>
        <label className="check">
          <input type="checkbox" checked={server.worktrees} onChange={e => save({ worktrees: e.target.checked }, 'worktree setting')} />
          Give each new worker its own git branch (worktree) when its folder is a git repo
        </label>
        <p className="muted small">Workers then never overwrite each other. Review a worker's changes in its panel and Merge or Discard them.</p>
        <div className="grid2">
          <label>Keep the detailed event log for (days)
            <input type="number" min={0} max={3650} defaultValue={server.retentionDays} key={server.retentionDays}
              onBlur={e => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); if (v !== server.retentionDays) save({ retentionDays: v }, 'log retention'); }} />
          </label>
        </div>
        <p className="muted small">Older output, tool and thinking events are removed from the database to keep it fast; 0 keeps everything. Agents, tasks and usage totals are always kept, and the full history files in <span className="mono">~/.agentix/history</span> are never trimmed.</p>
      </section>

      <section className="card">
        <h2>Memory search</h2>
        <p className="muted small">Shared context is always searched by keywords. With a local embedding model it also finds notes and files that mean the same thing in other words. Nothing leaves your machine.</p>
        {emb && (
          <>
            <div className="grid2">
              <label>Meaning search
                <select value={emb.provider} onChange={e => setEmb({ ...emb, provider: e.target.value as 'off' | 'ollama' })}>
                  <option value="off">Off (keywords only)</option><option value="ollama">Ollama (local)</option>
                </select>
              </label>
              <label>Model <input className="mono" value={emb.model} onChange={e => setEmb({ ...emb, model: e.target.value })} placeholder="nomic-embed-text" /></label>
              <label className="span2">Ollama address <input className="mono" value={emb.url} onChange={e => setEmb({ ...emb, url: e.target.value })} placeholder="http://127.0.0.1:11434" /></label>
            </div>
            <p className="muted small">Install Ollama, then run <span className="mono">ollama pull {emb.model || 'nomic-embed-text'}</span>.</p>
            <div className="row end">
              {embTest && <span className={`small grow ${embTest.startsWith('✓') ? 'st-working' : 'st-error'}`}>{embTest}</span>}
              <button className="btn" disabled={emb.provider === 'off'} onClick={async () => {
                setEmbTest('Testing…');
                await save({ embeddings: emb }, 'memory search');
                const r = await api.testEmbeddings().catch(e => ({ ok: false, error: String(e.message ?? e) }) as { ok: boolean; error?: string; dimensions?: number });
                setEmbTest(r.ok ? `✓ works (${r.dimensions} dimensions)` : `✕ ${r.error}`);
              }}>Test</button>
              <button className="btn primary" onClick={() => save({ embeddings: emb }, 'memory search')}>Save</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Agent CLIs</h2>
        <div className="row">
          <p className="muted small grow">Agentix runs each CLI by name from your PATH. Set a full path if it lives somewhere else.</p>
          <button className="btn small" onClick={() => navigate('/setup')}>Run setup again</button>
        </div>
        <table className="table">
          <thead><tr><th>Agent</th><th>Found</th><th>CLI path</th></tr></thead>
          <tbody>
            {adapters.map(a => (
              <tr key={a.kind}>
                <td><b>{a.kind}</b></td>
                <td>{a.installed ? <span className="st st-working">✓ {a.version}</span> : <span className="muted">not found</span>}</td>
                <td><input className="mono" placeholder={a.kind} value={paths[a.kind] ?? ''} onChange={e => setPaths({ ...paths, [a.kind]: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row end">
          <button className="btn" onClick={detect}>Check again</button>
          <button className="btn primary" onClick={() => save({ cliPaths: paths }, 'CLI paths').then(detect)}>Save paths</button>
        </div>
      </section>

      <section className="card">
        <h2>Voice (this browser)</h2>
        <label className="check"><input type="checkbox" checked={local.voice} disabled={!canSpeak} onChange={e => saveLocal({ ...local, voice: e.target.checked })} /> Read the CEO’s replies aloud</label>
        <div className="grid2">
          <label>Voice
            <select value={local.voiceName} onChange={e => saveLocal({ ...local, voiceName: e.target.value })} disabled={!voices.length}>
              <option value="">Browser default</option>
              {voices.map(v => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
            </select>
          </label>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <button className="btn" disabled={!canSpeak} onClick={() => speak('Hi kenz, the team is on it.', local.voiceName)}>Test voice</button>
          </div>
        </div>
        <p className="muted small">Talking to the CEO needs Chrome or Edge{canListen ? '' : ' (not available in this browser)'}; speech recognition usually needs internet.</p>
      </section>

      <section className="card">
        <h2>Server</h2>
        <p className="small">Dashboard and API: <span className="mono">{window.location.origin}</span>. Change the port by starting the server with <span className="mono">AGENTIX_PORT=4318 agentix server</span>. Data lives in <span className="mono">~/.agentix</span> (or <span className="mono">AGENTIX_HOME</span>).</p>
      </section>

      <section className="card reset-card">
        <h2>Start fresh</h2>
        <p className="muted small">Stop every agent and return to the first-run setup. This permanently removes the current agents, tasks, shared context, usage totals, and history. CLI paths and other server preferences stay saved.</p>
        <button className="btn danger" disabled={resetBusy} onClick={startFresh}>{resetBusy ? 'Resetting…' : 'Stop everything and start fresh'}</button>
      </section>
    </div>
  );
}
