// Start a fresh native session for any existing agent without leaving the current page.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { useStore } from '../store.ts';

export function NewSessionModal({ onClose }: { onClose(): void }) {
  const agentMap = useStore(s => s.agents);
  const agents = Object.values(agentMap).sort((a, b) => a.name.localeCompare(b.name));
  const select = useStore(s => s.select);
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!agentId) return;
    setBusy(true);
    setError('');
    try {
      await api.newSession(agentId, clear);
      select(agentId);
      navigate('/');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const selected = agents.find(agent => agent.id === agentId);

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal session-modal" onSubmit={e => { e.preventDefault(); submit(); }}>
        <h2>New session</h2>
        <p className="muted session-modal-copy">Start a fresh native conversation for an existing agent.</p>
        <label>Agent
          <select value={agentId} onChange={e => setAgentId(e.target.value)} disabled={busy || !agents.length}>
            {agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name} · {agent.kind} · {agent.status}
              </option>
            ))}
          </select>
        </label>
        {selected?.nativeSessionId && <div className="session-current">Current session: {selected.nativeSessionId.slice(0, 12)}</div>}
        <label className="check session-clear">
          <input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} disabled={busy} />
          Clear this agent’s visible conversation too
        </label>
        {error && <div className="error">{error}</div>}
        {!agents.length && <div className="warn">Create an agent before starting a session.</div>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !agentId}>{busy ? 'Starting…' : 'Start session'}</button>
        </div>
      </form>
    </div>
  );
}
