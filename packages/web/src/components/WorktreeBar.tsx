// A worker's own git branch: what it changed, a diff view, and Merge / Discard.
import { useEffect, useState } from 'react';
import { api, type WorktreeStatus } from '../api.ts';
import type { Agent } from '../../../shared/src/types.ts';

const FILE_COLOR: Record<string, string> = { A: 'add', M: 'mod', D: 'del', R: 'mod' };

export function WorktreeBar({ agent, onError }: { agent: Agent; onError(msg: string): void }) {
  const [st, setSt] = useState<WorktreeStatus>();
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const running = ['thinking', 'working', 'starting'].includes(agent.status);

  const refresh = () => api.worktree(agent.id).then(setSt).catch(e => onError(e instanceof Error ? e.message : String(e)));
  // Refresh when the panel opens and whenever the worker finishes a turn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDone(''); if (!running) refresh(); }, [agent.id, running]);

  if (!agent.worktree) return null;

  async function act(fn: () => Promise<string>) {
    setBusy(true); setDone(''); onError('');
    try { setDone(await fn()); await refresh(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const n = st?.files.length ?? 0;

  return (
    <div className="worktree">
      <span className="branch mono" title={`${agent.worktree.path}\nfrom ${agent.worktree.repo}`}>⎇ {agent.worktree.branch}</span>
      <span className="muted small">{st ? (n ? `${n} file${n === 1 ? '' : 's'} changed` : 'no changes') : '…'}</span>
      {done && <span className="small st-working">{done}</span>}
      <div className="grow" />
      <button className="btn small" disabled={!n} onClick={() => setShowDiff(true)}>Diff</button>
      <button className="btn small merge" disabled={!n || running || busy} title={running ? 'Wait until it finishes' : `Merge into ${st?.target ?? 'the repo'}`}
        onClick={() => act(async () => { const r = await api.merge(agent.id); return `merged into ${r.into}`; })}>Merge</button>
      <button className="btn small danger" disabled={!n || running || busy}
        onClick={() => { if (window.confirm(`Throw away everything ${agent.name} changed on ${agent.worktree!.branch}?`)) act(async () => { await api.discard(agent.id); return 'discarded'; }); }}>Discard</button>
      {showDiff && st && (
        <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowDiff(false); }}>
          <div className="modal diff-modal">
            <div className="row">
              <h2 className="grow">{agent.name}'s changes <span className="muted small mono">{st.branch} → {st.target}</span></h2>
              <button className="icon-btn" onClick={() => setShowDiff(false)} aria-label="Close">✕</button>
            </div>
            <div className="diff-files">
              {st.files.map(f => <div key={f.path} className={`mono small f-${FILE_COLOR[f.status] ?? 'mod'}`}>{f.status} {f.path}</div>)}
            </div>
            <pre className="diff">{st.diff.split('\n').map((l, i) => (
              <span key={i} className={l.startsWith('+++') || l.startsWith('---') ? 'd-file' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : ''}>{l}{'\n'}</span>
            ))}</pre>
            {st.truncated && <p className="muted small">The diff is cut short here; open {st.path} to see all of it.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
