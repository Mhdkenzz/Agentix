// Every agent in one table: filter, edit name/role/avatar, bulk interrupt/remove.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { useStore, fmtTokens, fmtCost } from '../store.ts';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import { AVATARS } from '../avatars/index.ts';
import { ChangeModelModal } from '../components/ModelPicker.tsx';
import type { Agent, Role } from '../../../shared/src/types.ts';

const BUSY = ['thinking', 'working', 'starting'];

export function Agents() {
  const agents = useStore(s => s.agents);
  const select = useStore(s => s.select);
  const usage = useStore(s => s.usage);
  const navigate = useNavigate();
  const [role, setRole] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [modelFor, setModelFor] = useState<Agent>();

  const all = Object.values(agents);
  const kinds = [...new Set(all.map(a => a.kind))].sort();
  const statuses = [...new Set(all.map(a => a.status))].sort();
  const rows = useMemo(() => all
    .filter(a => (!role || a.role === role) && (!kind || a.kind === kind) && (!status || a.status === status)
      && (!q || `${a.name} ${a.id} ${a.activity} ${a.cwd}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => ({ ceo: 0, coordinator: 1, worker: 2 }[a.role] - { ceo: 0, coordinator: 1, worker: 2 }[b.role]) || a.createdAt - b.createdAt),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [agents, role, kind, status, q]);
  const chosen = rows.filter(a => picked.has(a.id));

  async function run(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  async function patch(a: Agent, p: Partial<Agent>) {
    try {
      await api.update(a.id, p);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && window.confirm(`${e.message}.\n\nMake ${a.name} the ${p.role} instead?`)) {
        return run(() => api.update(a.id, { ...p, replace: true }));
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const toggle = (id: string) => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="page">
      <h1>Agents <span className="muted small">{rows.length} of {all.length}</span></h1>
      <div className="filters">
        <input placeholder="Search name, id, activity, folder…" value={q} onChange={e => setQ(e.target.value)} />
        <select value={role} onChange={e => setRole(e.target.value)}>
          <option value="">All roles</option><option value="ceo">CEO</option><option value="coordinator">Coordinator</option><option value="worker">Worker</option>
        </select>
        <select value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">All kinds</option>{kinds.map(k => <option key={k}>{k}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>{statuses.map(k => <option key={k}>{k}</option>)}
        </select>
        <div className="grow" />
        <button className="btn small" disabled={!chosen.some(a => BUSY.includes(a.status))}
          onClick={() => run(() => Promise.all(chosen.map(a => api.interrupt(a.id))))}>Stop {chosen.length || ''}</button>
        <button className="btn small danger" disabled={!chosen.length}
          onClick={() => { if (window.confirm(`Remove ${chosen.length} agent(s)? Their history is kept.`)) run(() => Promise.all(chosen.map(a => api.remove(a.id))).then(() => setPicked(new Set()))); }}>
          Remove {chosen.length || ''}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {modelFor && <ChangeModelModal agentId={modelFor.id} kind={modelFor.kind} name={modelFor.name} current={modelFor.model} onClose={() => setModelFor(undefined)} />}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={!!rows.length && chosen.length === rows.length}
                onChange={e => setPicked(e.target.checked ? new Set(rows.map(a => a.id)) : new Set())} aria-label="Select all" /></th>
              <th>Agent</th><th>Kind</th><th>Model</th><th>Role</th><th>Avatar</th><th>Status</th><th>Doing</th><th title="All-time tokens (input + output)">Tokens</th><th>Cost</th><th>Folder</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(a => (
              <tr key={a.id} className={picked.has(a.id) ? 'picked' : ''}>
                <td><input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Select ${a.name}`} /></td>
                <td>
                  <div className="row">
                    <AvatarThumb id={a.avatarId} size={30} />
                    <div>
                      <input className="inline" defaultValue={a.name} key={a.name}
                        onBlur={e => { const v = e.target.value.trim(); if (v && v !== a.name) patch(a, { name: v }); }}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
                      <div className="muted small mono">{a.id}</div>
                    </div>
                  </div>
                </td>
                <td>{a.kind}</td>
                <td><button className="link-btn model-tag ellipsis" title="Change the model" onClick={() => setModelFor(a)}>{a.model ?? 'default'}</button></td>
                <td>
                  <select className="inline" value={a.role} onChange={e => patch(a, { role: e.target.value as Role })}>
                    <option value="worker">worker</option><option value="coordinator">coordinator</option><option value="ceo">CEO</option>
                  </select>
                </td>
                <td>
                  <select className="inline" value={a.avatarId} onChange={e => patch(a, { avatarId: Number(e.target.value) })}>
                    {AVATARS.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </td>
                <td><span className={`st st-${a.status}`}>{a.status}</span></td>
                <td className="ellipsis" title={a.activity}>{a.activity}</td>
                <td className="num" title={usage[a.id] ? `${usage[a.id].turns} turns · ${usage[a.id].input.toLocaleString()} in · ${usage[a.id].output.toLocaleString()} out` : 'no usage reported yet'}>
                  {usage[a.id] ? fmtTokens(usage[a.id].input + usage[a.id].output) : <span className="muted">–</span>}</td>
                <td className="num">{fmtCost(usage[a.id]?.cost) || <span className="muted">–</span>}</td>
                <td className="ellipsis mono small" title={a.worktree ? `${a.cwd}\nbranch ${a.worktree.branch}` : a.cwd}>{a.worktree && <span className="branch-tag">⎇</span>}{a.cwd}</td>
                <td>
                  <div className="row">
                    <button className="btn small" onClick={() => { select(a.id); navigate('/'); }}>Watch</button>
                    <button className="btn small ghost" onClick={() => navigate(`/history?agent=${a.id}`)}>History</button>
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={12} className="muted pad">No agents match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
