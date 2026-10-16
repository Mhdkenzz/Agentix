import { OfficeScene } from '../office/OfficeScene.tsx';
import { AgentPanel } from '../components/AgentPanel.tsx';
import { useStore } from '../store.ts';

export function Office({ active = true }: { active?: boolean }) {
  const empty = useStore(s => Object.keys(s.agents).length === 0);
  const setShowNewAgent = useStore(s => s.setShowNewAgent);
  return (
    <div className="office">
      <OfficeScene active={active} />
      {empty && (
        <div className="empty-hint">
          <p>The office is empty.</p>
          <button className="btn primary" onClick={() => setShowNewAgent(true)}>+ Hire your first agent</button>
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: '#a78bfa' }} />thinking</span>
        <span><i style={{ background: '#34d399' }} />working</span>
        <span><i style={{ background: '#fbbf24' }} />waiting</span>
        <span><i style={{ background: '#f87171' }} />error</span>
        <span><i style={{ background: '#7d7d7d' }} />idle</span>
        <span className="muted">drag to orbit · scroll to zoom · click an agent</span>
      </div>
      {active && <AgentPanel />}
    </div>
  );
}
