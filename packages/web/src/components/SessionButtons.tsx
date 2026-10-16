// "New session" and "Clear" for one agent: both start a fresh native session (no memory of the old
// conversation); Clear also hides the earlier messages here. Nothing is deleted: History keeps it all.
import { useState } from 'react';
import { api } from '../api.ts';
import type { Agent } from '../../../shared/src/types.ts';

export function SessionButtons({ agent, onError }: { agent: Agent; onError(msg: string): void }) {
  const [busy, setBusy] = useState(false);
  async function run(clear: boolean) {
    const what = clear
      ? `Clear ${agent.name}? It starts a fresh session and its earlier messages are hidden here (History keeps them).`
      : `Start a new session for ${agent.name}? It forgets the current conversation; the messages stay on screen.`;
    if (!window.confirm(what)) return;
    setBusy(true);
    onError('');
    try { await api.newSession(agent.id, clear); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <button className="btn small" disabled={busy} onClick={() => run(false)} title="Fresh session, keep the messages on screen">New session</button>
      <button className="btn small" disabled={busy} onClick={() => run(true)} title="Fresh session and a clean screen">Clear</button>
    </>
  );
}
