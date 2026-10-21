// Talk to the CEO: push-to-talk (hold Space or the mic), spoken replies, text fallback.
// The CEO only talks to the coordinator, but each of its turns includes the whole team's status.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useStore, sinceClear } from '../store.ts';
import { SessionButtons } from '../components/SessionButtons.tsx';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import { canListen, canSpeak, listen, speak, stopSpeaking } from '../voice.ts';
import { loadSettings, saveSettings } from '../settings.ts';
import { NewAgentModal } from '../components/NewAgentModal.tsx';
import type { Agent, AgentEvent } from '../../../shared/src/types.ts';

/** What the CEO "said": its output without the @@ command lines. */
function spoken(text: string): string {
  return text.split('\n').filter(l => !/^\s*(?:[-*>]\s*)?`?@@/.test(l)).join('\n').trim();
}

interface Line { id: number; who: 'you' | 'ceo' | 'coordinator' | 'system'; text: string; ts: number; note?: string }

export function Ceo() {
  const agents = useStore(s => s.agents);
  const events = useStore(s => s.events);
  const setHistory = useStore(s => s.setHistory);
  const lastEventId = useStore(s => s.lastEventId);
  const ceo = useMemo(() => Object.values(agents).find(a => a.role === 'ceo'), [agents]);
  const coordinator = useMemo(() => Object.values(agents).find(a => a.role === 'coordinator'), [agents]);
  const ceoId = ceo?.id;
  const coordinatorId = coordinator?.id;
  const [settings, setSettings] = useState(loadSettings);
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const [hire, setHire] = useState(false);
  const stopRef = useRef<(() => void) | undefined>(undefined);
  const spokenUpTo = useRef(lastEventId); // only read out replies that arrive after the page opened
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ceoId) api.events(ceoId).then(l => setHistory(ceoId, l)).catch(() => {});
    if (coordinatorId) api.events(coordinatorId).then(l => setHistory(coordinatorId, l)).catch(() => {});
  }, [ceoId, coordinatorId, setHistory]);

  const lines: Line[] = useMemo(() => {
    if (!ceo) return [];
    const out: Line[] = [];
    const add = (e: AgentEvent, who: Line['who'], text: string, note?: string) => out.push({ id: e.id, who, text, ts: e.ts, note });
    const mine = sinceClear(events[ceo.id]);
    const since = mine[0]?.type === 'session' ? mine[0].id : 0; // after a Clear, only what came later
    for (const e of mine) {
      if (e.type === 'session') add(e, 'system', e.text ?? '');
      else if (e.type === 'steer' && e.from === 'user') add(e, 'you', e.text ?? '');
      else if (e.type === 'output' && e.text) { const t = spoken(e.text); if (t) add(e, 'ceo', t); }
      else if (e.type === 'message' && e.from === coordinator?.id) add(e, 'coordinator', e.text ?? '', 'reported to the CEO');
      else if (e.type === 'message' && e.from === 'system') add(e, 'system', e.text ?? '');
      else if (e.type === 'error') add(e, 'system', e.text ?? '');
    }
    if (coordinator) {
      for (const e of events[coordinator.id] ?? []) {
        if (e.id > since && e.type === 'message' && e.from === ceo.id) add(e, 'ceo', e.text ?? '', `told ${coordinator.name}`);
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }, [ceo, coordinator, events]);

  // Speak new CEO replies.
  useEffect(() => {
    if (!ceo) return;
    for (const e of events[ceo.id] ?? []) {
      if (e.id <= spokenUpTo.current) continue;
      spokenUpTo.current = e.id;
      if (settings.voice && e.type === 'output' && e.text) speak(spoken(e.text), settings.voiceName);
    }
  }, [ceo, events, settings.voice, settings.voiceName]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [lines.length]);

  async function send(text: string) {
    const t = text.trim();
    if (!t || !ceo) return;
    setDraft(''); setError('');
    try { await api.steer(ceo.id, t); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  function startTalking() {
    if (listening || !ceo) return;
    stopSpeaking();
    setError('');
    setListening(true);
    stopRef.current = listen(setDraft, finalText => { setListening(false); stopRef.current = undefined; if (finalText) send(finalText); }, msg => { setError(msg); setListening(false); });
  }
  function stopTalking() { stopRef.current?.(); }

  // Hold Space to talk (unless typing in a field).
  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat && !typing(e)) { e.preventDefault(); startTalking(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e)) { e.preventDefault(); stopTalking(); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  function toggleVoice() {
    const next = { ...settings, voice: !settings.voice };
    if (!next.voice) stopSpeaking();
    setSettings(next); saveSettings(next);
  }

  if (!ceo) {
    return (
      <div className="page ceo-empty">
        <h1>CEO</h1>
        <p className="muted">There's no CEO yet. The CEO talks with you (by voice if you like), knows what every agent is doing, and passes your requests to the coordinator.</p>
        <button className="btn primary" onClick={() => setHire(true)}>+ Hire a CEO</button>
        {hire && <NewAgentModal initialRole="ceo" onClose={() => setHire(false)} />}
      </div>
    );
  }

  const busy = ['thinking', 'working', 'starting'].includes(ceo.status);
  return (
    <div className="ceo">
      <section className="ceo-main">
        <header className="ceo-head">
          <AvatarThumb id={ceo.avatarId} size={52} />
          <div className="grow">
            <div className="panel-title">{ceo.name} <span className="muted">· CEO · {ceo.kind}</span></div>
            <div className="muted small">{busy ? 'thinking…' : 'listening'} · talks only to {coordinator ? coordinator.name : 'the coordinator (none yet)'}</div>
          </div>
          <SessionButtons agent={ceo} onError={setError} />
          <label className="check"><input type="checkbox" checked={settings.voice} onChange={toggleVoice} disabled={!canSpeak} /> speak replies</label>
        </header>
        <div className="chat" ref={logRef}>
          {lines.length === 0 && <div className="muted pad">Say hello. Hold <kbd>Space</kbd> or the mic button to talk.</div>}
          {lines.map(l => (
            <div key={l.id} className={`bubble-line from-${l.who}`}>
              <div className="who">{l.who === 'you' ? 'You' : l.who === 'ceo' ? ceo.name : l.who === 'coordinator' ? coordinator?.name ?? 'Coordinator' : 'Agentix'}{l.note && <span className="muted"> · {l.note}</span>}</div>
              <div className="say">{l.text}</div>
            </div>
          ))}
          {busy && <div className="bubble-line from-ceo"><div className="say typing">…</div></div>}
        </div>
        {error && <div className="error">{error}</div>}
        <form className="talk" onSubmit={e => { e.preventDefault(); send(draft); }}>
          <button type="button" className={`mic ${listening ? 'on' : ''}`} disabled={!canListen}
            onPointerDown={startTalking} onPointerUp={stopTalking} onPointerLeave={() => listening && stopTalking()}
            title={canListen ? 'Hold to talk' : 'Voice input needs Chrome or Edge'}>🎙</button>
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={listening ? 'Listening…' : `Message ${ceo.name}…`} />
          <button className="btn primary" disabled={!draft.trim()}>Send</button>
        </form>
        <div className="muted small hint">{canListen
          ? 'Hold Space (or the mic) to talk, release to send. Voice uses your browser’s speech service, which usually needs internet.'
          : 'Voice input needs Chrome or Edge. Typing works everywhere.'}</div>
      </section>
      <aside className="ceo-side">
        <ThinkingPanel ceo={ceo} events={sinceClear(events[ceo.id])} busy={busy} />
        {coordinator && <CoordinatorCard coordinator={coordinator} onError={setError} />}
        <TeamSidebar agents={Object.values(agents)} />
      </aside>
    </div>
  );
}

/** The CEO's current turn as it happens: its thinking, the tools it runs, what it says. */
function ThinkingPanel({ ceo, events, busy }: { ceo: Agent; events: AgentEvent[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const turn = useMemo(() => {
    let start = -1;
    events.forEach((e, i) => { if (e.type === 'steer' || e.type === 'session' || (e.type === 'message' && e.from !== ceo.id)) start = i; });
    return events.slice(start + 1).filter(e => ['thinking', 'tool', 'output', 'error'].includes(e.type));
  }, [events, ceo.id]);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [turn.length]);

  return (
    <section className="mind">
      <h3>{busy ? `${ceo.name} is thinking` : `${ceo.name}'s last turn`}</h3>
      <div className="mind-log" ref={ref}>
        {turn.length === 0 && <div className="muted small">{busy ? ceo.activity || 'thinking…' : 'Nothing yet. Its thoughts show up here while it works.'}</div>}
        {turn.map(e => (
          <div key={e.id} className={`mind-${e.type}`}>
            {e.type === 'tool' ? <span className="mono">🛠 {e.text}</span> : e.type === 'error' ? <>⚠️ {e.text}</> : e.type === 'output' ? spoken(e.text ?? '') || e.text : e.text}
          </div>
        ))}
        {busy && turn.length > 0 && <div className="muted small">{ceo.activity}</div>}
      </div>
    </section>
  );
}

/** The coordinator's session controls, so both leads can be reset from one place. */
function CoordinatorCard({ coordinator, onError }: { coordinator: Agent; onError(msg: string): void }) {
  return (
    <section className="lead-card">
      <AvatarThumb id={coordinator.avatarId} size={30} />
      <div className="grow">
        <div><b>{coordinator.name}</b> <span className="muted small">coordinator</span></div>
        <div className="muted small"><span className={`st st-${coordinator.status}`}>{coordinator.status}</span> · {coordinator.kind}</div>
      </div>
      <div className="lead-actions"><SessionButtons agent={coordinator} onError={onError} /></div>
    </section>
  );
}

function TeamSidebar({ agents }: { agents: Agent[] }) {
  const order = { ceo: 0, coordinator: 1, worker: 2 } as const;
  return (
    <section className="team">
      <h3>What the CEO knows</h3>
      {[...agents].sort((a, b) => order[a.role] - order[b.role] || a.createdAt - b.createdAt).map(a => (
        <div key={a.id} className="team-row">
          <AvatarThumb id={a.avatarId} size={30} />
          <div className="grow">
            <div><b>{a.name}</b> <span className="muted small">{a.role !== 'worker' ? a.role : a.kind}</span></div>
            <div className="muted small ellipsis"><span className={`st st-${a.status}`}>{a.status}</span> · {a.activity}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
