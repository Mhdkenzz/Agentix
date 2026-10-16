import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { api, connectStream } from './api.ts';
import { useStore } from './store.ts';
import { TopBar } from './components/TopBar.tsx';
import { NewAgentModal } from './components/NewAgentModal.tsx';
import { Office } from './pages/Office.tsx';
import { Placeholder } from './pages/Placeholder.tsx';
import { Ceo } from './pages/Ceo.tsx';

export function App() {
  const showNewAgent = useStore(s => s.showNewAgent);
  const setShowNewAgent = useStore(s => s.setShowNewAgent);
  const onOffice = useLocation().pathname === '/';

  useEffect(() => {
    const { setAgents, applyEvent, setConnected } = useStore.getState();
    let stop = () => {};
    // Snapshot first, then only the events after it. The panel loads an agent's history on demand.
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    const start = () => api.snapshot().then(s => {
      if (cancelled) return;
      setAgents(s.agents);
      stop = connectStream(s.lastEventId, applyEvent, c => {
        setConnected(c);
        if (c) api.agents().then(setAgents).catch(() => {}); // resync after a reconnect
      });
    }).catch(() => { setConnected(false); retry = setTimeout(start, 2000); });
    start();
    api.settings().then(useStore.getState().setServerSettings).catch(() => {});
    return () => { cancelled = true; clearTimeout(retry); stop(); };
  }, []);

  return (
    <div className="app">
      <TopBar />
      <main>
        {/* The office stays mounted (paused while hidden): remounting the WebGL canvas is slow,
            and unmounting drei <Html> labels throws a removeChild error. */}
        <div className="route-office" hidden={!onOffice}><Office active={onOffice} /></div>
        <Routes>
          <Route path="/" element={null} />
          <Route path="/ceo" element={<Ceo />} />
          <Route path="/agents" element={<Placeholder title="Agents" />} />
          <Route path="/history" element={<Placeholder title="History" />} />
          <Route path="/settings" element={<Placeholder title="Settings" />} />
        </Routes>
      </main>
      {showNewAgent && <NewAgentModal onClose={() => setShowNewAgent(false)} />}
    </div>
  );
}
