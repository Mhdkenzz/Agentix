// One event in a log: icon, who, text.
import type { AgentEvent } from '../../../shared/src/types.ts';
import { useStore } from '../store.ts';

const ICON: Record<string, string> = {
  output: '💬', tool: '🛠', thinking: '💭', status: '•', steer: '🧭', message: '✉️', error: '⚠️',
  'agent.created': '✨', 'agent.updated': '✎', 'agent.removed': '🗑', session: '↺', usage: '◔', task: '☑',
};

export function EventLine({ e, showAgent = false }: { e: AgentEvent; showAgent?: boolean }) {
  const live = useStore(s => s.agents);
  const archived = useStore(s => s.archived);
  const agents = { ...archived, ...live };
  const who = e.from === 'user' ? 'you' : e.from === 'system' ? 'agentix' : e.from ? (agents[e.from]?.name ?? e.from) : '';
  const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const text = e.type === 'status' ? ((e.data as any)?.activity ?? e.text) : e.text;
  return (
    <div className={`ev ev-${e.type.replace('.', '-')}`}>
      <span className="ev-icon">{ICON[e.type] ?? '·'}</span>
      <div className="ev-body">
        <div className="ev-meta">
          {showAgent && <b>{agents[e.agentId]?.name ?? e.agentId}</b>}
          {who && <span>from {who}</span>}
          <span className="ev-type">{e.type}</span>
          <span className="ev-time">{time}</span>
        </div>
        {text && <div className="ev-text">{text}</div>}
      </div>
    </div>
  );
}
