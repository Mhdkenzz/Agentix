// The team's task board: what each agent is on, what waits for review, what is blocked.
// The coordinator adds tasks with "@@task"; a worker's tasks move to doing while it works and to review when it
// finishes. Drag a card to another column, or use its status menu.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import type { PermissionRequest, Task, TaskStatus } from '../../../shared/src/types.ts';

const COLUMNS: { id: TaskStatus; title: string }[] = [
  { id: 'todo', title: 'To do' }, { id: 'doing', title: 'Doing' }, { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' }, { id: 'blocked', title: 'Blocked' },
];

export function Tasks() {
  const tasks = useStore(s => s.tasks);
  const agents = useStore(s => s.agents);
  const archived = useStore(s => s.archived);
  const select = useStore(s => s.select);
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [who, setWho] = useState('');
  const [error, setError] = useState('');
  const [over, setOver] = useState<TaskStatus>();
  const [approvals, setApprovals] = useState<PermissionRequest[]>([]);
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    const load = () => api.approvals().then(rows => { if (live) setApprovals(rows); }).catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const workers = Object.values(agents).filter(a => a.role === 'worker').sort((a, b) => a.createdAt - b.createdAt);
  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const t of Object.values(tasks)) {
      if (who && (t.owner ?? '') !== (who === '-' ? '' : who)) continue;
      (m[t.status] ??= []).push(t);
    }
    for (const list of Object.values(m)) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [tasks, who]);
  const name = (id?: string) => !id ? '' : id === 'user' ? 'you' : agents[id]?.name ?? archived[id]?.name ?? id;

  async function act(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const move = (id: string, status: TaskStatus) => tasks[id]?.status !== status && act(() => api.editTask(id, { status }));
  const decide = (request: PermissionRequest, decision: 'approved' | 'declined') => act(async () => {
    await api.decideApproval(request.id, decision, approvalNotes[request.id] ?? '');
    setApprovals(await api.approvals());
  });

  return (
    <div className="page tasks">
      <div className="row">
        <h1 className="grow">Tasks <span className="muted small">{Object.keys(tasks).length}</span></h1>
        <select className="who-filter" value={who} onChange={e => setWho(e.target.value)} aria-label="Filter by owner">
          <option value="">Everyone</option><option value="-">No owner</option>
          {workers.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <p className="muted lead">
        The coordinator plans here with <span className="mono">@@task</span>. A worker's tasks move to <b className="st-working">doing</b> while
        it works and to <b className="st-thinking">review</b> when it finishes; you or the coordinator mark them done.
      </p>
      {approvals.length > 0 && <section className="approval-list">
        <h2>Permission requests <span className="muted small">{approvals.filter(a => a.status === 'pending').length} waiting</span></h2>
        {approvals.filter(a => a.status === 'pending').map(a => (
          <article className="approval-card" key={a.id}>
            <div className="task-meta"><b>{name(a.workerId)}</b><span className="muted mono">{a.id}{a.taskId ? ` · ${a.taskId}` : ''}</span><span className="grow" /><span className="muted small">{new Date(a.createdAt).toLocaleString()}</span></div>
            <div className="approval-request">{a.request}</div>
            <div className="row approval-actions">
              <input className="grow" value={approvalNotes[a.id] ?? ''} onChange={e => setApprovalNotes(n => ({ ...n, [a.id]: e.target.value }))} placeholder="Approved scope or decline reason" aria-label={`Decision for ${a.id}`} />
              <button className="btn primary" disabled={!approvalNotes[a.id]?.trim()} onClick={() => decide(a, 'approved')}>Approve</button>
              <button className="btn" onClick={() => decide(a, 'declined')}>Decline</button>
            </div>
          </article>
        ))}
        {approvals.some(a => a.status !== 'pending') && <details className="approval-history">
          <summary>Recent decisions</summary>
          {approvals.filter(a => a.status !== 'pending').slice(0, 8).map(a => (
            <article className="approval-card resolved" key={a.id}>
              <div className="task-meta"><b>{name(a.workerId)}</b><span className="muted mono">{a.id}{a.taskId ? ` · ${a.taskId}` : ''}</span><span className="grow" /><b className={a.status === 'approved' ? 'c-on' : 'c-err'}>{a.status}</b></div>
              <div className="approval-request">{a.request}</div>
              {a.decision && <div className="muted small">Decision: {a.decision}</div>}
            </article>
          ))}
        </details>}
      </section>}
      <form className="row add-task" onSubmit={e => {
        e.preventDefault();
        const t = title.trim();
        if (t) act(() => api.addTask({ title: t, owner: owner || undefined }).then(() => setTitle('')));
      }}>
        <input className="grow" value={title} onChange={e => setTitle(e.target.value)} placeholder="New task, e.g. “Add a login page with tests”" />
        <select value={owner} onChange={e => setOwner(e.target.value)} aria-label="Owner">
          <option value="">no owner</option>
          {workers.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn primary" disabled={!title.trim()}>Add task</button>
      </form>
      {error && <div className="error">{error}</div>}
      <div className="board">
        {COLUMNS.map(c => (
          <section key={c.id} className={`col col-${c.id} ${over === c.id ? 'over' : ''}`} data-status={c.id}
            onDragOver={e => { e.preventDefault(); setOver(c.id); }}
            onDragLeave={() => setOver(o => (o === c.id ? undefined : o))}
            onDrop={e => { e.preventDefault(); setOver(undefined); move(e.dataTransfer.getData('text/task'), c.id); }}>
            <h3>{c.title} <span className="muted">{byStatus[c.id]?.length ?? 0}</span></h3>
            {(byStatus[c.id] ?? []).map(t => (
              <article key={t.id} className="task" draggable onDragStart={e => e.dataTransfer.setData('text/task', t.id)}>
                <div className="task-title">{t.title}</div>
                {t.note && <div className="task-note">{t.note}</div>}
                <div className="task-meta">
                  {t.owner && agents[t.owner]
                    ? <button className="owner" onClick={() => { select(t.owner); navigate('/'); }} title={`Open ${name(t.owner)}`}><AvatarThumb id={agents[t.owner].avatarId} size={18} />{name(t.owner)}</button>
                    : <span className="muted">{t.owner ? name(t.owner) : 'no owner'}</span>}
                  <span className="muted mono">{t.id}</span>
                  <div className="grow" />
                  {t.status === 'blocked' && t.owner && agents[t.owner]?.role === 'worker' &&
                    <button className="btn small" title={`Reopen ${t.id} and send it back to ${agents[t.owner].name}`} onClick={() => act(() => api.editTask(t.id, { status: 'todo' }))}>Retry</button>}
                  <select className="inline" value={t.status} onChange={e => move(t.id, e.target.value as TaskStatus)} aria-label={`Status of ${t.title}`}>
                    {COLUMNS.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                  <button className="icon-btn" title="Delete task" onClick={() => {
                    if (window.confirm(`Delete ${t.id}: ${t.title}? This cannot be undone.`)) act(() => api.deleteTask(t.id));
                  }}>✕</button>
                </div>
                <div className="muted small">by {name(t.by)} · {new Date(t.updatedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
