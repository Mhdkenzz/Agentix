// First-run setup: scan this machine for agent CLIs, choose who coordinates, then let the coordinator
// agent build the team. Shown on first launch (no agents, setup not done) and from Settings.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type CoordinatorMode, type FoundCli, type ScanResult } from '../api.ts';
import { useStore } from '../store.ts';
import { ModelPicker } from '../components/ModelPicker.tsx';

const WHO: { id: CoordinatorMode; title: string; text: string }[] = [
  { id: 'human', title: 'You', text: 'You create and direct every agent yourself.' },
  { id: 'agent', title: 'An agent', text: 'A coordinator agent creates the workers and directs them. You talk to it (or to a CEO).' },
  { id: 'both', title: 'You + an agent', text: 'The coordinator builds and runs the team, and you can still steer anyone directly.' },
];

export function Setup() {
  const navigate = useNavigate();
  const setServerSettings = useStore(s => s.setServerSettings);
  const select = useStore(s => s.select);
  const setShowNewAgent = useStore(s => s.setShowNewAgent);
  const existing = useStore(s => s.agents);
  const [scan, setScan] = useState<ScanResult>();
  const [scanning, setScanning] = useState(false);
  const [who, setWho] = useState<CoordinatorMode>('both');
  const [coordKind, setCoordKind] = useState('');
  const [coordName, setCoordName] = useState('');
  const [coordModel, setCoordModel] = useState('');
  const [ceoModel, setCeoModel] = useState('');
  const [withCeo, setWithCeo] = useState(false);
  const [ceoKind, setCeoKind] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const usable = useMemo(() => (scan?.found ?? []).filter(f => f.supported && f.runs), [scan]);
  const hasCoordinator = Object.values(existing).some(a => a.role === 'coordinator');

  async function runScan() {
    setScanning(true); setError('');
    try {
      const r = await api.scan();
      setScan(r);
      const first = r.found.find(f => f.supported && f.runs)?.kind ?? '';
      setCoordKind(k => k || first);
      setCeoKind(k => k || first);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setScanning(false); }
  }
  useEffect(() => { runScan(); }, []);

  async function finish(skip = false) {
    setBusy(true); setError('');
    try {
      // CLIs found outside PATH get their full path saved, so Agentix can run them.
      const cliPaths: Record<string, string> = {};
      for (const f of usable) if (!f.on_path) cliPaths[f.kind] = f.path;
      const server = await api.settings();
      setServerSettings(await api.saveSettings({
        setupDone: true,
        ...(skip ? {} : {
          coordinatorMode: who,
          cliPaths: { ...cliPaths, ...server.cliPaths },
          ...(usable[0] ? { defaultKind: usable.find(f => f.kind === server.defaultKind)?.kind ?? usable[0].kind } : {}),
        }),
      }));
      if (skip) { navigate('/'); return; }

      if (who === 'human') { navigate('/'); setShowNewAgent(true); return; }

      const kinds = usable.map(f => f.kind).join(', ');
      const first = task.trim()
        ? `${task.trim()}\n\nThis is the team's first task from kenz. Create the worker agents it needs with @@spawn ` +
          `(installed agent CLIs on this machine: ${kinds}), give each a clear job, then report back with a short plan.`
        : undefined;
      const coordinator = await api.create({ kind: coordKind, role: 'coordinator', name: coordName.trim() || undefined, avatarId: 'random', prompt: first, replace: true, model: coordModel || undefined });
      if (withCeo) await api.create({ kind: ceoKind, role: 'ceo', avatarId: 'random', replace: true, model: ceoModel || undefined });
      if (withCeo) navigate('/ceo');
      else { select(coordinator.id); navigate('/'); }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const needsAgent = who !== 'human';
  const canFinish = !busy && (!needsAgent || (coordKind && (!withCeo || ceoKind)));

  return (
    <div className="page setup">
      <h1>Set up Agentix</h1>
      <p className="muted lead">Three quick steps. You can change all of this later in Settings.</p>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <div className="row">
          <h2 className="grow"><span className="step">1</span> Agent CLIs on this machine</h2>
          <button className="btn small" disabled={scanning} onClick={runScan}>{scanning ? 'Scanning…' : 'Scan again'}</button>
        </div>
        {!scan && <p className="muted small">{scanning ? 'Looking on PATH and in the usual install folders…' : ''}</p>}
        {scan && scan.found.length === 0 && (
          <p className="small">No agent CLIs found. Install one (for example Codex, Claude Code or OpenCode), then scan again.</p>
        )}
        {scan && scan.found.length > 0 && (
          <div className="found">
            {scan.found.map(f => <FoundRow key={f.kind} f={f} />)}
          </div>
        )}
        {scan && <p className="muted small">Scanned with {scan.scanner === 'python' ? 'Python' : 'Node (Python not found)'} on {scan.platform}.</p>}
      </section>

      <section className="card">
        <h2><span className="step">2</span> Who coordinates?</h2>
        <div className="mode-cards">
          {WHO.map(m => (
            <button key={m.id} className={`mode-card ${who === m.id ? 'on' : ''}`} onClick={() => setWho(m.id)}>
              <b>{m.title}</b><span className="muted small">{m.text}</span>
            </button>
          ))}
        </div>
        {needsAgent && (
          <div className="grid2 setup-pick">
            <label>Coordinator agent
              <select value={coordKind} onChange={e => { setCoordKind(e.target.value); setCoordModel(''); }}>
                {!usable.length && <option value="">no supported CLI found</option>}
                {usable.map(f => <option key={f.kind} value={f.kind}>{f.name}{f.version ? ` (${f.version})` : ''}</option>)}
              </select>
            </label>
            <label>Its name <input value={coordName} onChange={e => setCoordName(e.target.value)} placeholder="random" /></label>
            {coordKind && <div className="span2"><ModelPicker kind={coordKind} value={coordModel} onChange={setCoordModel} label="Coordinator model" /></div>}
            <label className="check span2">
              <input type="checkbox" checked={withCeo} onChange={e => setWithCeo(e.target.checked)} />
              Also hire a CEO you can talk to (by voice too). It passes your requests to the coordinator.
            </label>
            {withCeo && (
              <label>CEO agent
                <select value={ceoKind} onChange={e => { setCeoKind(e.target.value); setCeoModel(''); }}>
                  {usable.map(f => <option key={f.kind} value={f.kind}>{f.name}</option>)}
                </select>
              </label>
            )}
            {withCeo && ceoKind && <ModelPicker kind={ceoKind} value={ceoModel} onChange={setCeoModel} label="CEO model" />}
          </div>
        )}
        {needsAgent && hasCoordinator && <p className="muted small">You already have a coordinator; the new one takes over and the old one becomes a worker.</p>}
      </section>

      <section className="card">
        <h2><span className="step">3</span> {needsAgent ? 'What should the team do first?' : 'Create your first agent'}</h2>
        {needsAgent ? (
          <>
            <textarea rows={3} value={task} onChange={e => setTask(e.target.value)}
              placeholder="e.g. Build a small todo web app in ~/projects/todo with tests. (Optional: leave empty to just meet the coordinator.)" />
            <p className="muted small">The coordinator reads this, creates the worker agents it needs, and starts them.</p>
          </>
        ) : <p className="muted small">After setup, the New agent window opens so you can create your first agent.</p>}
        <div className="row end">
          <button className="btn ghost" disabled={busy} onClick={() => finish(true)}>Skip setup</button>
          <button className="btn primary" disabled={!canFinish} onClick={() => finish()}>{busy ? 'Setting up…' : needsAgent && task.trim() ? 'Create the team' : 'Finish'}</button>
        </div>
      </section>
    </div>
  );
}

function FoundRow({ f }: { f: FoundCli }) {
  return (
    <div className="found-row">
      <span className={`dot ${f.supported ? (f.runs ? 'ok' : 'warn') : 'off'}`} />
      <div className="grow">
        <b>{f.name}</b> <span className="muted small">{f.version || (f.runs ? '' : 'did not answer --version')}</span>
        <div className="muted small mono ellipsis" title={f.all_paths.join('\n')}>{f.path}{f.all_paths.length > 1 ? `  (+${f.all_paths.length - 1} more)` : ''}</div>
      </div>
      <span className={`pill ${f.supported ? 'pill-ok' : ''}`}>{f.supported ? 'can join the team' : 'not supported yet'}</span>
    </div>
  );
}
