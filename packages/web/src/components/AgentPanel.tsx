// Side panel for the clicked agent: live log, steer box, interrupt/stop/remove.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useStore, sinceClear, fmtTokens, fmtCost } from '../store.ts';
import { WorktreeBar } from './WorktreeBar.tsx';
import { ChangeModelModal } from './ModelPicker.tsx';
import { SessionButtons } from './SessionButtons.tsx';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import { avatarFor } from '../avatars/index.ts';
import { EventLine } from './EventLine.tsx';

export function AgentPanel() {
  const id = useStore(s => s.selectedId);
  const agent = useStore(s => (id ? s.agents[id] : undefined));
  const events = useStore(s => (id ? s.events[id] : undefined));
  const select = useStore(s => s.select);
  const setHistory = useStore(s => s.setHistory);
  const mode = useStore(s => s.server?.coordinatorMode);
  const coordinator = useStore(s => Object.values(s.agents).find(a => a.role === 'coordinator'));
  const usage = useStore(s => (id ? s.usage[id] : undefined));
  const allTasks = useStore(s => s.tasks);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [hideStatus, setHideStatus] = useState(true);
  const [editModel, setEditModel] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!id) return;
    setError('');
    api.events(id).then(list => setHistory(id, list)).catch(() => {});
  }, [id, setHistory]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events?.length, id]);

  if (!id || !agent) return null;
  const shown = sinceClear(events).filter(e => !hideStatus || (e.type !== 'status' && e.type !== 'usage'));
  const myTasks = Object.values(allTasks).filter(t => t.owner === agent.id && t.status !== 'done').sort((a, b) => a.createdAt - b.createdAt);
  const busy = ['thinking', 'working', 'starting'].includes(agent.status);
  // In "agent coordinates" mode, instructions for workers go through the coordinator.
  const viaCoordinator = mode === 'agent' && agent.role === 'worker' && !!coordinator;

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function steer() {
    const t = text.trim();
    if (!t) return;
    setText('');
    stick.current = true;
    await act(() => viaCoordinator ? api.askCoordinator(t, agent!.id) : api.steer(agent!.id, t));
  }

  return (
    <aside className="panel">
      <header className="panel-head">
        <AvatarThumb id={agent.avatarId} size={44} />
        <div className="grow">
          <div className="panel-title">{agent.name} <span className="muted">· {avatarFor(agent.avatarId).name}</span></div>
          <div className="muted small">{agent.kind} · <button className="link-btn model-tag" title="Change the model" onClick={() => setEditModel(true)}>{agent.model ?? 'default model'}</button> · {agent.role} · <span className={`st st-${agent.status}`}>{agent.status}</span></div>
          <div className="activity" title={agent.activity}>{agent.activity}</div>
        </div>
        <button className="icon-btn" onClick={() => select(undefined)} aria-label="Close">✕</button>
      </header>
      <div className="panel-sub muted small" title={agent.cwd}>📁 {agent.cwd}{agent.nativeSessionId ? ` · session ${agent.nativeSessionId.slice(0, 12)}` : ''}</div>
      {usage && (
        <div className="panel-sub usage-line small" title={`${usage.turns} turns · ${usage.input.toLocaleString()} in · ${usage.output.toLocaleString()} out${usage.cacheRead ? ` · ${usage.cacheRead.toLocaleString()} from cache` : ''}`}>
          ◔ {fmtTokens(usage.input + usage.output)} tokens <span className="muted">({fmtTokens(usage.input)} in, {fmtTokens(usage.output)} out)</span>{usage.cost ? <> · <span className="cost">{fmtCost(usage.cost)}</span></> : ''}
        </div>
      )}
      <WorktreeBar agent={agent} onError={setError} />
      {myTasks.length > 0 && (
        <div className="panel-tasks">
          {myTasks.map(t => <div key={t.id} className={`ptask ptask-${t.status}`} title={t.note}><span className="ptask-st">{t.status}</span>{t.title}</div>)}
        </div>
      )}
      <div className="row panel-tools">
        <label className="check"><input type="checkbox" checked={hideStatus} onChange={e => setHideStatus(e.target.checked)} /> hide status and usage lines</label>
        <div className="grow" />
        <SessionButtons agent={agent} onError={setError} />
        <button className="btn small" disabled={!busy} onClick={() => act(() => api.interrupt(agent.id))}>Interrupt</button>
        <button className="btn small danger" onClick={() => { if (confirmRemove(agent.name)) act(() => api.remove(agent.id)); }}>Remove</button>
      </div>
      <div className="log" ref={logRef} onScroll={e => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}>
        {shown.length ? shown.map(e => <EventLine key={e.id} e={e} />) : <div className="muted pad">No events yet.</div>}
      </div>
      {error && <div className="error">{error}</div>}
      {editModel && <ChangeModelModal agentId={agent.id} kind={agent.kind} name={agent.name} current={agent.model} onClose={() => setEditModel(false)} />}
      <form className="steer" onSubmit={e => { e.preventDefault(); steer(); }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); steer(); } }}
          placeholder={viaCoordinator ? `Ask ${coordinator!.name} (coordinator) about ${agent.name}…`
            : busy ? `Steer ${agent.name} (interrupts the current turn)…` : `Tell ${agent.name} what to do…`}
          rows={2}
        />
        <button className="btn primary" disabled={!text.trim()}>Send</button>
      </form>
      {agent.role === 'worker' && coordinator && mode !== 'human' && (
        <div className="muted small hint">{viaCoordinator
          ? `Agent-coordinates mode: your note goes to ${coordinator.name}, who directs ${agent.name}.`
          : `${coordinator.name} (coordinator) is told about every steer.`}</div>
      )}
    </aside>
  );
}

function confirmRemove(name: string): boolean {
  // A plain confirm keeps this dependency-free.
  return window.confirm(`Stop and remove ${name}? Its history is kept (History page and ~/.agentix/history).`);
}
