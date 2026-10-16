// Pick the model an agent runs with, from the models its CLI offers.
// Short lists (Codex, Claude Code) are a dropdown; long ones (OpenCode, Pi: hundreds via OpenRouter) get a
// provider filter and a search box. Codex models also take a reasoning level, sent as "<model>:<level>".
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ModelList } from '../api.ts';

const cache = new Map<string, Promise<ModelList>>();
function load(kind: string, refresh = false): Promise<ModelList> {
  if (refresh || !cache.has(kind)) cache.set(kind, api.models(kind, refresh).catch(e => ({ models: [], error: String(e.message ?? e) })));
  return cache.get(kind)!;
}

const SHORT = 40;

export function ModelPicker({ kind, value, onChange, label = 'Model' }: { kind: string; value: string; onChange(v: string): void; label?: string }) {
  const [list, setList] = useState<ModelList>();
  const [loading, setLoading] = useState(false);
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const request = useRef(0);

  const fetchList = (refresh = false) => {
    if (!kind) return;
    const requestId = ++request.current;
    setLoading(true);
    load(kind, refresh).then(l => {
      if (requestId === request.current) { setList(l); setLoading(false); }
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setList(undefined); setGroup(''); setQuery('');
    request.current++;
    setLoading(false);
    if (!kind) return;
    fetchList();
  }, [kind]);

  const models = list?.models ?? [];
  // "<model>:<effort>" only for models that list efforts (Codex); Pi ids can contain ":" themselves.
  const [base, effort] = useMemo(() => {
    const i = value.lastIndexOf(':');
    if (i > 0 && models.find(m => m.id === value.slice(0, i))?.efforts) return [value.slice(0, i), value.slice(i + 1)];
    return [value, ''];
  }, [value, models]);
  const chosen = models.find(m => m.id === base);
  const groups = useMemo(() => [...new Set(models.map(m => m.group).filter(Boolean))] as string[], [models]);
  const long = models.length > SHORT;
  const shown = useMemo(() => models.filter(m => (!group || m.group === group)
    && (!query || `${m.id} ${m.label ?? ''} ${m.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [models, group, query]);
  const def = list?.current ? `CLI default (${list.current})` : 'CLI default';
  const selectedEffort = chosen?.efforts?.includes(effort) ? effort : '';

  const setBase = (b: string) => {
    const m = models.find(x => x.id === b);
    onChange(b && m?.efforts && effort && m.efforts.includes(effort) ? `${b}:${effort}` : b);
  };

  return (
    <div className="model-picker">
      <span className="row">{label}
        <span className="grow" />
        {loading ? <span className="muted small">loading models…</span>
          : <button type="button" className="link-btn small" onClick={() => fetchList(true)} title="Ask the CLI again">refresh list</button>}
      </span>
      {!long && models.length > 0 ? (
        <div className="row">
          <select aria-label={label} value={chosen ? base : ''} onChange={e => setBase(e.target.value)}>
            <option value="">{def}</option>
            {models.map(m => <option key={m.id} value={m.id} title={m.description}>{m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id}</option>)}
          </select>
          {chosen?.efforts && (
            <select className="effort" value={selectedEffort} onChange={e => onChange(e.target.value ? `${base}:${e.target.value}` : base)} aria-label="Reasoning level">
              <option value="">{chosen.defaultEffort ? `${chosen.defaultEffort} (default)` : 'default level'}</option>
              {chosen.efforts.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          )}
        </div>
      ) : (
        <div className="row">
          {long && groups.length > 1 && (
            <select className="model-group" value={group} onChange={e => setGroup(e.target.value)} aria-label="Provider">
              <option value="">all providers ({models.length})</option>
              {groups.map(g => <option key={g} value={g}>{g} ({models.filter(m => m.group === g).length})</option>)}
            </select>
          )}
          {models.length > 0 ? <>
            {long && <input className="mono" aria-label={`${label} search`} value={query} onChange={e => setQuery(e.target.value)} placeholder={`Search ${shown.length} available models`} />}
            <select aria-label={label} value={shown.some(m => m.id === base) ? base : ''} onChange={e => setBase(e.target.value)}>
              <option value="">{def}</option>
              {shown.map(m => <option key={m.id} value={m.id} title={m.description}>{m.label && m.label !== m.id ? `${m.label} · ${m.id}` : m.id}</option>)}
            </select>
            {chosen?.efforts && <select className="effort" value={selectedEffort} onChange={e => onChange(e.target.value ? `${base}:${e.target.value}` : base)} aria-label="Reasoning level">
              <option value="">{chosen.defaultEffort ? `${chosen.defaultEffort} (default)` : 'default level'}</option>
              {chosen.efforts.map(x => <option key={x} value={x}>{x}</option>)}
            </select>}
          </> : <select aria-label={label} value="" disabled><option value="">{def}</option></select>}
        </div>
      )}
      <span className="muted small">
        {list?.error ? list.error
          : chosen?.description ? chosen.description
          : models.length ? `${models.length} models from ${kind}. Leave empty for the CLI's default.`
          : list ? `No selectable models were reported by ${kind}; leave empty for its CLI default.` : ''}
        {chosen === undefined && value && models.length > 0 ? ` Saved model "${value}" is not in the current available list.` : ''}
      </span>
    </div>
  );
}

/** "Change model" for an existing agent; takes effect from its next turn. */
export function ChangeModelModal({ agentId, kind, name, current, onClose }: { agentId: string; kind: string; name: string; current?: string; onClose(): void }) {
  const [model, setModel] = useState(current ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try { await api.update(agentId, { model: model || null }); onClose(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal model-modal" onSubmit={e => { e.preventDefault(); save(); }}>
        <h2>{name}'s model</h2>
        <p className="muted small">Used from {name}'s next turn. The conversation continues.</p>
        <ModelPicker kind={kind} value={model} onChange={setModel} />
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || model === (current ?? '')}>Save</button>
        </div>
      </form>
    </div>
  );
}
