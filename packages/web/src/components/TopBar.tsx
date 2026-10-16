// Page links, live counts by status, connection dot, "+ New agent".
import { NavLink } from 'react-router-dom';
import { useStore } from '../store.ts';
import { api, type CoordinatorMode } from '../api.ts';

const MODE_LABEL: Record<CoordinatorMode, string> = { human: 'You coordinate', agent: 'Agent coordinates', both: 'You + agent' };

/** Who coordinates: kenz, the coordinator agent, or both. */
export function CoordinatorModeSelect() {
  const server = useStore(s => s.server);
  const setServerSettings = useStore(s => s.setServerSettings);
  const coordinator = useStore(s => Object.values(s.agents).find(a => a.role === 'coordinator'));
  if (!server) return null;
  return (
    <label className="mode" title={coordinator ? `Coordinator agent: ${coordinator.name}` : 'No coordinator agent yet'}>
      <span>Coordinator</span>
      <select value={server.coordinatorMode} onChange={e => api.saveSettings({ coordinatorMode: e.target.value as CoordinatorMode }).then(setServerSettings)}>
        {(Object.keys(MODE_LABEL) as CoordinatorMode[]).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </select>
      {server.coordinatorMode !== 'human' && !coordinator && <span className="c-wait" title="Create an agent with the Coordinator role">no agent</span>}
    </label>
  );
}

const PAGES = [['/', 'Office'], ['/ceo', 'CEO'], ['/agents', 'Agents'], ['/context', 'Context'], ['/history', 'History'], ['/settings', 'Settings']] as const;

export function TopBar() {
  const agents = useStore(s => s.agents);
  const connected = useStore(s => s.connected);
  const setShowNewAgent = useStore(s => s.setShowNewAgent);
  const list = Object.values(agents);
  const count = (pred: (s: string) => boolean) => list.filter(a => pred(a.status)).length;
  const busy = count(s => s === 'thinking' || s === 'working' || s === 'starting');
  const waiting = count(s => s === 'waiting_input');
  const errors = count(s => s === 'error');
  return (
    <nav className="topbar">
      <div className="brand"><span className="logo">A</span>Agentix</div>
      <div className="links">
        {PAGES.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
      </div>
      <div className="grow" />
      <CoordinatorModeSelect />
      <div className="counts">
        <span title="agents">{list.length} agents</span>
        <span className="c-busy" title="busy">● {busy} busy</span>
        {waiting > 0 && <span className="c-wait">● {waiting} waiting</span>}
        {errors > 0 && <span className="c-err">● {errors} error</span>}
        <span className={connected ? 'c-on' : 'c-off'} title={connected ? 'live' : 'reconnecting to the server…'}>{connected ? 'live' : 'offline'}</span>
      </div>
      <button className="btn primary" onClick={() => setShowNewAgent(true)}>+ New agent</button>
    </nav>
  );
}
