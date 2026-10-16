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
        <span><i style={{ background: '#b48cff' }} />thinking</span>
        <span><i style={{ background: '#38e07b' }} />working</span>
        <span><i style={{ background: '#ffb000' }} />waiting</span>
        <span><i style={{ background: '#ff4d5e' }} />error</span>
        <span><i style={{ background: '#8a93a6' }} />idle</span>
        <span className="muted">drag to orbit · scroll to zoom · click an agent</span>
      </div>
      {active && <AgentPanel />}
    </div>
  );
}
