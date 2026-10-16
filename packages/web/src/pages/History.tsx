// Searchable event history across all agents, with "resume" (a new turn on the agent's own session).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import { EventLine } from '../components/EventLine.tsx';
import type { AgentEvent } from '../../../shared/src/types.ts';

const TYPES = ['output', 'tool', 'steer', 'message', 'error', 'status', 'agent.created'];
const PAGE = 150;

export function History() {
  const agents = useStore(s => s.agents);
  const lastEventId = useStore(s => s.lastEventId);
  const [params, setParams] = useSearchParams();
  const agentId = params.get('agent') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [types, setTypes] = useState<string[]>(['output', 'tool', 'steer', 'message', 'error']);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stats, setStats] = useState<Record<string, { count: number; lastTs: number }>>({});
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resumeText, setResumeText] = useState('continue where you left off');
  const [note, setNote] = useState('');

  async function load(before?: number) {
    setLoading(true);
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (q) p.set('q', q);
    if (agentId) p.set('agent', agentId);
    if (types.length) p.set('type', types.join(','));
    if (before) p.set('before', String(before));
    try {
      const r = await fetch(`/api/events?${p}`).then(r => r.json());
      setEvents(prev => before ? [...prev, ...r.events] : r.events);
      setStats(Object.fromEntries(r.stats.map((s: any) => [s.agentId, s])));
      setMore(r.events.length === PAGE);
    } finally { setLoading(false); }
  }

  // Reload on filter change, and (debounced) as new events arrive.
  useEffect(() => { const t = setTimeout(() => load(), 250); return () => clearTimeout(t); }, // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, agentId, types.join(','), Math.floor(lastEventId / 25)]);

  const agent = agentId ? agents[agentId] : undefined;
  const list = Object.values(agents).sort((a, b) => (stats[b.id]?.lastTs ?? b.createdAt) - (stats[a.id]?.lastTs ?? a.createdAt));
  const pick = (id: string) => { const n = new URLSearchParams(params); id ? n.set('agent', id) : n.delete('agent'); setParams(n); setNote(''); };

  async function resume() {
    if (!agent || !resumeText.trim()) return;
    setNote('');
    try {
      await api.steer(agent.id, resumeText.trim());
      setNote(agent.nativeSessionId ? `Resumed ${agent.name}'s session ${agent.nativeSessionId.slice(0, 12)}.` : `Started a new turn for ${agent.name}.`);
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="history">
      <aside className="hist-agents">
        <button className={`hist-agent ${!agentId ? 'on' : ''}`} onClick={() => pick('')}>
          <div className="random-thumb small-thumb">∗</div>
          <div className="grow"><b>All agents</b><div className="muted small">{Object.values(stats).reduce((n, s) => n + s.count, 0)} events</div></div>
        </button>
        {list.map(a => (
          <button key={a.id} className={`hist-agent ${agentId === a.id ? 'on' : ''}`} onClick={() => pick(a.id)}>
            <AvatarThumb id={a.avatarId} size={30} />
            <div className="grow">
              <b>{a.name}</b> <span className="muted small">{a.role !== 'worker' ? a.role : a.kind}</span>
              <div className="muted small">{stats[a.id]?.count ?? 0} events · {stats[a.id] ? new Date(stats[a.id].lastTs).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'none'}</div>
            </div>
          </button>
        ))}
      </aside>
      <section className="hist-main">
        <div className="filters">
          <input placeholder={`Search ${agent ? agent.name + "'s" : 'all'} history…`} value={q} onChange={e => setQ(e.target.value)} />
          <div className="chips">
            {TYPES.map(t => (
              <button key={t} className={`chip ${types.includes(t) ? 'on' : ''}`}
                onClick={() => setTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}>{t}</button>
            ))}
          </div>
        </div>
        {agent && (
          <div className="resume">
            <div className="grow">
              <b>{agent.name}</b> <span className="muted small">{agent.kind} · {agent.status} · {agent.nativeSessionId ? `session ${agent.nativeSessionId}` : 'no saved session yet'}</span>
            </div>
            <input value={resumeText} onChange={e => setResumeText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') resume(); }} />
            <button className="btn primary small" onClick={resume}>Resume</button>
          </div>
        )}
        {note && <div className="muted small pad">{note}</div>}
        <div className="hist-log">
          {events.map(e => <EventLine key={e.id} e={e} showAgent={!agentId} />)}
          {!events.length && !loading && <div className="muted pad">Nothing found.</div>}
          {more && <button className="btn small load-more" disabled={loading} onClick={() => load(events.at(-1)?.id)}>{loading ? 'Loading…' : 'Load older'}</button>}
        </div>
      </section>
    </div>
  );
}
