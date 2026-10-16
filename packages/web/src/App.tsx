import { useEffect, useRef } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { api, connectStream } from './api.ts';
import { useStore } from './store.ts';
import { TopBar } from './components/TopBar.tsx';
import { NewAgentModal } from './components/NewAgentModal.tsx';
import { Office } from './pages/Office.tsx';
import { Agents } from './pages/Agents.tsx';
import { History } from './pages/History.tsx';
import { Settings } from './pages/Settings.tsx';
import { Ceo } from './pages/Ceo.tsx';
import { Context } from './pages/Context.tsx';
import { Setup } from './pages/Setup.tsx';
import { Tasks } from './pages/Tasks.tsx';

export function App() {
  const showNewAgent = useStore(s => s.showNewAgent);
  const setShowNewAgent = useStore(s => s.setShowNewAgent);
  const { pathname } = useLocation();
  const onOffice = pathname === '/';
  const navigate = useNavigate();
  const server = useStore(s => s.server);
  const agentCount = useStore(s => Object.keys(s.agents).length);
  const connected = useStore(s => s.connected);

  // First launch: no agents and setup never finished -> the setup wizard (once per page load).
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || !server || !connected) return;
    offered.current = true;
    if (!server.setupDone && agentCount === 0 && pathname !== '/setup') navigate('/setup');
  }, [server, connected, agentCount, pathname, navigate]);

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
    api.tasks().then(useStore.getState().setTasks).catch(() => {});
    api.usage().then(u => useStore.getState().setUsage(u.total, u.today)).catch(() => {});
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
          <Route path="/agents" element={<Agents />} />
          <Route path="/history" element={<History />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/context" element={<Context />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/setup" element={<Setup />} />
        </Routes>
      </main>
      {showNewAgent && <NewAgentModal onClose={() => setShowNewAgent(false)} />}
    </div>
  );
}
