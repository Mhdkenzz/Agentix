// Server settings (coordinator mode, defaults, CLI paths) and this browser's voice preferences.
import { useEffect, useRef, useState } from 'react';
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
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [local, setLocal] = useState(loadSettings);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  const detect = () => api.adapters().then(setAdapters).catch(e => setError(String(e.message ?? e)));
  useEffect(() => { detect(); }, []);
  // Take the saved paths once; later saves of other settings must not wipe what's being typed.
  const pathsLoaded = useRef(false);
  useEffect(() => { if (server && !pathsLoaded.current) { pathsLoaded.current = true; setPaths(server.cliPaths); } }, [server]);
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
        <h2>Agent CLIs</h2>
        <p className="muted small">Agentix runs each CLI by name from your PATH. Set a full path if it lives somewhere else.</p>
        <table className="table">
          <thead><tr><th>Agent</th><th>Found</th><th>CLI path</th></tr></thead>
          <tbody>
            {adapters.filter(a => a.kind !== 'mock').map(a => (
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
    </div>
  );
}
