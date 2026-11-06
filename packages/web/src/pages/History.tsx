// Searchable event history across every agent ever created (removed ones included), with "resume"
// (a new turn on the agent's own session) for agents that are still in the office.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import { EventLine } from '../components/EventLine.tsx';
import type { AgentChat, AgentEvent } from '../../../shared/src/types.ts';

const TYPES = ['output', 'tool', 'thinking', 'steer', 'message', 'session', 'error', 'status', 'agent.created', 'agent.removed'];
const DEFAULT_TYPES = ['output', 'tool', 'thinking', 'steer', 'message', 'error'];
const PAGE = 150;

export function History() {
  const live = useStore(s => s.agents);
  const archived = useStore(s => s.archived);
  const setArchived = useStore(s => s.setArchived);
  const agents = useMemo(() => ({ ...archived, ...live }), [archived, live]);
  const [historyDir, setHistoryDir] = useState('');
  const lastEventId = useStore(s => s.lastEventId);
  const [params, setParams] = useSearchParams();
  const agentId = params.get('agent') ?? '';
  const chatId = params.get('chat') ?? '';
  const lastAgentEvent = useStore(s => agentId ? s.events[agentId]?.at(-1) : undefined);
  const chatBoundaryEventId = lastAgentEvent?.type === 'session' || lastAgentEvent?.type === 'agent.created' ? lastAgentEvent.id : undefined;
  const [chats, setChats] = useState<AgentChat[]>([]);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [types, setTypes] = useState<string[]>(params.has('types')
    ? (params.get('types') ?? '').split(',').filter(t => TYPES.includes(t))
    : DEFAULT_TYPES);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [stats, setStats] = useState<Record<string, { count: number; lastTs: number }>>({});
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loadSequence = useRef(0);
  const [resumeText, setResumeText] = useState('continue where you left off');
  const [note, setNote] = useState('');
  const selectedChat = chats.find(c => c.id === chatId);

  async function load(before?: number) {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    if (types.length === 0) {
      setEvents([]); setStats({}); setMore(false); setLoading(false);
      return;
    }
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (q) p.set('q', q);
    if (agentId) p.set('agent', agentId);
    p.set('type', types.join(','));
    if (selectedChat) {
      p.set('after', String(selectedChat.startEventId - 1));
      const upper = before ?? selectedChat.beforeEventId;
      if (upper) p.set('before', String(upper));
    } else if (before) p.set('before', String(before));
    try {
      const r = await api.searchEvents(p);
      if (sequence !== loadSequence.current) return;
      setEvents(prev => before ? [...prev, ...r.events] : r.events);
      setStats(Object.fromEntries(r.stats.map((s: any) => [s.agentId, s])));
      setMore(r.events.length === PAGE);
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setLoadError(e instanceof Error ? e.message : String(e));
      if (!before) setEvents([]);
      setMore(false);
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }

  // Reload on filter change, and (debounced) as new events arrive.
  useEffect(() => { const t = setTimeout(() => load(), 250); return () => clearTimeout(t); }, // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, agentId, chatId, selectedChat?.startEventId, selectedChat?.beforeEventId, types.join(','), Math.floor(lastEventId / 25)]);

  // Keep filters bookmarkable, and follow browser back/forward navigation.
  useEffect(() => {
    setQ(params.get('q') ?? '');
    setTypes(params.has('types')
      ? (params.get('types') ?? '').split(',').filter(t => TYPES.includes(t))
      : DEFAULT_TYPES);
  }, [params]);

  function updateFilters(nextQ: string, nextTypes: string[]) {
    setQ(nextQ); setTypes(nextTypes);
    const next = new URLSearchParams(params);
    if (nextQ) next.set('q', nextQ); else next.delete('q');
    // Presence with an empty value intentionally means no event types selected.
    next.set('types', nextTypes.join(','));
    setParams(next, { replace: true });
  }

  useEffect(() => {
    setChats([]);
    if (!agentId) return;
    api.chats(agentId).then(setChats).catch(() => {});
  }, [agentId, chatBoundaryEventId]);

  // Removed agents come from the server; their history is kept.
  const removedCount = Object.keys(archived).length;
  useEffect(() => { api.allAgents().then(r => { setArchived(r.agents); setHistoryDir(r.historyDir); }).catch(() => {}); },
    [setArchived, removedCount]);

  const agent = agentId ? agents[agentId] : undefined;
  const list = Object.values(agents).sort((a, b) => (stats[b.id]?.lastTs ?? b.createdAt) - (stats[a.id]?.lastTs ?? a.createdAt));
  const pick = (id: string) => { const n = new URLSearchParams(params); if (id) n.set('agent', id); else n.delete('agent'); n.delete('chat'); setParams(n); setNote(''); };
  const pickChat = (id: string) => { const n = new URLSearchParams(params); if (id) n.set('chat', id); else n.delete('chat'); setParams(n); };

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
              {a.archivedAt && <span className="removed-tag">removed</span>}
              <div className="muted small">{stats[a.id]?.count ?? 0} events · {stats[a.id] ? new Date(stats[a.id].lastTs).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'none'}</div>
            </div>
          </button>
        ))}
      </aside>
      <section className="hist-main">
        <div className="filters">
          <select className="hist-mobile-agent" aria-label="Choose agent history" value={agentId} onChange={e => pick(e.target.value)}>
            <option value="">All agents</option>
            {list.map(a => <option key={a.id} value={a.id}>{a.name}{a.archivedAt ? ' (removed)' : ''}</option>)}
          </select>
          {agent && <select aria-label="Saved chats" value={chatId} onChange={e => pickChat(e.target.value)}>
            <option value="">All chats</option>
            {chats.map(chat => <option key={chat.id} value={chat.id}>
              {new Date(chat.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · {chat.title} · {chat.eventCount} events
            </option>)}
          </select>}
          <input aria-label={`Search ${agent ? agent.name + "'s" : 'all'} history`} placeholder={`Search ${agent ? agent.name + "'s" : 'all'} history…`} value={q} onChange={e => updateFilters(e.target.value, types)} />
          <div className="chips">
            {TYPES.map(t => (
              <button key={t} className={`chip ${types.includes(t) ? 'on' : ''}`}
                aria-pressed={types.includes(t)}
                onClick={() => updateFilters(q, types.includes(t) ? types.filter(x => x !== t) : [...types, t])}>{t}</button>
            ))}
          </div>
        </div>
        {agent?.archivedAt && (
          <div className="resume">
            <div className="grow">
              <b>{agent.name}</b> <span className="muted small">{agent.kind} · removed {new Date(agent.archivedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                {historyDir && <> · saved in <span className="mono">{historyDir}/{agent.id}.jsonl</span></>}</span>
            </div>
          </div>
        )}
        {agent && !agent.archivedAt && (
          <div className="resume">
            <div className="grow">
              <b>{agent.name}</b> <span className="muted small">{agent.kind} · {agent.status} · {agent.nativeSessionId ? `session ${agent.nativeSessionId}` : 'no saved session yet'}</span>
            </div>
            <input aria-label="Instruction for the new turn" value={resumeText} onChange={e => setResumeText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') resume(); }} />
            <button className="btn primary small" onClick={resume}>Resume</button>
          </div>
        )}
        {note && <div className="muted small pad">{note}</div>}
        {loadError && <div className="error" role="alert">Could not load history: {loadError} <button className="btn small" disabled={loading} onClick={() => load()}>{loading ? 'Retrying…' : 'Retry'}</button></div>}
        <div className="hist-log">
          {events.map(e => <EventLine key={e.id} e={e} showAgent={!agentId} />)}
          {!events.length && !loading && <div className="muted pad">Nothing found.</div>}
          {more && <button className="btn small load-more" disabled={loading} onClick={() => load(events.at(-1)?.id)}>{loading ? 'Loading…' : 'Load older'}</button>}
        </div>
      </section>
    </div>
  );
}
