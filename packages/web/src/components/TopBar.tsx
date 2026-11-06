// Page links, live counts by status, session switching, connection dot, "+ New agent".
import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useStore, fmtTokens, fmtCost } from '../store.ts';
import { api, type CoordinatorMode } from '../api.ts';
import { NewSessionModal } from './NewSessionModal.tsx';

const MODE_LABEL: Record<CoordinatorMode, string> = { human: 'You coordinate', agent: 'Agent coordinates', both: 'You + agent' };

/** Who coordinates: kenz, the coordinator agent, or both. */
export function CoordinatorModeSelect() {
  const server = useStore(s => s.server);
  const setServerSettings = useStore(s => s.setServerSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const coordinator = useStore(s => Object.values(s.agents).find(a => a.role === 'coordinator'));
  if (!server) return null;
  async function changeMode(mode: CoordinatorMode) {
    setSaving(true); setError('');
    try { setServerSettings(await api.saveSettings({ coordinatorMode: mode })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return (
    <label className="mode" title={error || (coordinator ? `Coordinator agent: ${coordinator.name}` : 'No coordinator agent yet')}>
      <span>Coordinator</span>
      <select value={server.coordinatorMode} disabled={saving} aria-busy={saving} onChange={e => changeMode(e.target.value as CoordinatorMode)}>
        {(Object.keys(MODE_LABEL) as CoordinatorMode[]).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </select>
      {saving && <span className="muted small" role="status">Saving…</span>}
      {error && <span className="c-err small" role="alert">Save failed</span>}
      {server.coordinatorMode !== 'human' && !coordinator && <span className="c-wait" title="Create an agent with the Coordinator role">no agent</span>}
    </label>
  );
}

const PAGES = [['/', 'Office'], ['/ceo', 'CEO'], ['/agents', 'Agents'], ['/tasks', 'Tasks'], ['/context', 'Context'], ['/history', 'History'], ['/settings', 'Settings']] as const;

export function TopBar() {
  const agents = useStore(s => s.agents);
  const connected = useStore(s => s.connected);
  const needsToken = useStore(s => s.needsToken);
  const select = useStore(s => s.select);
  const setShowNewAgent = useStore(s => s.setShowNewAgent);
  const navigate = useNavigate();
  const [showNewSession, setShowNewSession] = useState(false);
  const list = useMemo(() => Object.values(agents), [agents]);
  const activeSessions = useMemo(() => list
    .filter(agent => agent.nativeSessionId && agent.status !== 'stopped')
    .sort((a, b) => a.name.localeCompare(b.name)), [list]);
  const { busy, waiting, errors } = useMemo(() => list.reduce((counts, agent) => {
    if (agent.status === 'thinking' || agent.status === 'working' || agent.status === 'starting') counts.busy++;
    else if (agent.status === 'waiting_input') counts.waiting++;
    else if (agent.status === 'error') counts.errors++;
    return counts;
  }, { busy: 0, waiting: 0, errors: 0 }), [list]);
  const usageToday = useStore(s => s.usageToday);
  const { tokensToday, costToday } = useMemo(() => Object.values(usageToday).reduce((totals, usage) => {
    totals.tokensToday += usage.input + usage.output;
    totals.costToday += usage.cost ?? 0;
    return totals;
  }, { tokensToday: 0, costToday: 0 }), [usageToday]);
  return (
    <header className="topbar">
      <div className="brand">Agentix</div>
      <nav className="links" aria-label="Main navigation">
        {PAGES.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
      </nav>
      <div className="grow" />
      <CoordinatorModeSelect />
      <div className="counts">
        <span title="agents">{list.length} agents</span>
        {tokensToday > 0 && <span className="c-tokens" title={`Tokens used today by all agents${costToday ? `, ${fmtCost(costToday)}` : ''}`}>{fmtTokens(tokensToday)} tokens today</span>}
        <span className="c-busy" title="busy">● {busy} busy</span>
        {waiting > 0 && <span className="c-wait">● {waiting} waiting</span>}
        {errors > 0 && <span className="c-err">● {errors} error</span>}
        {needsToken && (
          <span className="c-err" title="This server needs an API token. Open the dashboard with ?token=... — the server prints the link when it starts.">
            token required
          </span>
        )}
        <span className={connected ? 'c-on' : 'c-off'} title={connected ? 'live' : 'reconnecting to the server…'}>{connected ? 'live' : 'offline'}</span>
      </div>
      <div className="session-controls">
        <select
          className="session-select"
          aria-label="Active sessions"
          value=""
          disabled={!activeSessions.length}
          onChange={e => {
            if (!e.target.value) return;
            select(e.target.value);
            navigate('/');
          }}
        >
          <option value="">{activeSessions.length ? `Active sessions (${activeSessions.length})` : 'No active sessions'}</option>
          {activeSessions.map(agent => (
            <option key={agent.id} value={agent.id}>
              {agent.name} · {agent.kind} · {agent.status}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setShowNewSession(true)}>+ New session</button>
        <button className="btn primary" onClick={() => setShowNewAgent(true)}>+ New agent</button>
      </div>
      {showNewSession && <NewSessionModal onClose={() => setShowNewSession(false)} />}
    </header>
  );
}
