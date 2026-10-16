// "+ New agent": kind, role, name, folder, first prompt and avatar (or Random).
import { useEffect, useState } from 'react';
import { api, ApiError, type AdapterInfo } from '../api.ts';
import { AVATARS } from '../avatars/index.ts';
import { AvatarThumb } from '../avatars/AvatarThumb.tsx';
import { useStore } from '../store.ts';
import type { Role } from '../../../shared/src/types.ts';

export function NewAgentModal({ onClose, initialRole = 'worker' }: { onClose(): void; initialRole?: Role }) {
  const server = useStore(s => s.server);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [kind, setKind] = useState(server?.defaultKind || 'codex');
  const [role, setRole] = useState<Role>(initialRole);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState(server?.defaultCwd ?? '');
  const [prompt, setPrompt] = useState('');
  const [worktree, setWorktree] = useState(server?.worktrees ?? true);
  const [avatar, setAvatar] = useState<number | 'random'>('random');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<string>();
  const [busy, setBusy] = useState(false);
  const select = useStore(s => s.select);

  useEffect(() => {
    api.adapters().then(list => {
      setAdapters(list);
      if (!list.find(a => a.kind === kind && a.installed)) setKind(list.find(a => a.installed)?.kind ?? kind);
    }).catch(e => setError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(replace = false) {
    setBusy(true); setError(''); setConflict(undefined);
    try {
      const agent = await api.create({ kind, role, name: name.trim() || undefined, cwd: cwd.trim() || undefined, prompt: prompt.trim() || undefined, avatarId: avatar, replace, ...(role === 'worker' ? { worktree } : {}) });
      select(agent.id);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(e.message);
      else setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={e => { e.preventDefault(); submit(); }}>
        <h2>New agent</h2>
        <div className="grid2">
          <label>Agent
            <select value={kind} onChange={e => setKind(e.target.value)}>
              {adapters.map(a => (
                <option key={a.kind} value={a.kind} disabled={!a.installed}>
                  {a.kind}{a.installed ? (a.version && a.version !== a.kind ? ` (${a.version})` : '') : ' (not installed)'}
                </option>
              ))}
            </select>
          </label>
          <label>Role
            <select value={role} onChange={e => setRole(e.target.value as Role)}>
              <option value="worker">Worker</option>
              <option value="coordinator">Coordinator</option>
              <option value="ceo">CEO</option>
            </select>
          </label>
          <label>Name <input value={name} onChange={e => setName(e.target.value)} placeholder="random" /></label>
          <label>Working folder <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="~/.agentix/workspace" /></label>
        </div>
        {role === 'worker' && (
          <label className="check wt-check" title="Only when the folder is inside a git repository">
            <input type="checkbox" checked={worktree} onChange={e => setWorktree(e.target.checked)} />
            Own git branch (worktree) if the folder is a git repo, so it never clashes with other workers. You merge its work when it's ready.
          </label>
        )}
        <label>First prompt
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} placeholder="optional: what should it do first?" />
        </label>
        <div className="label">Avatar</div>
        <div className="avatar-grid">
          <button type="button" className={`avatar-opt ${avatar === 'random' ? 'on' : ''}`} onClick={() => setAvatar('random')}>
            <div className="random-thumb">?</div><span>Random</span>
          </button>
          {AVATARS.map(a => (
            <button type="button" key={a.id} className={`avatar-opt ${avatar === a.id ? 'on' : ''}`} onClick={() => setAvatar(a.id)}>
              <AvatarThumb id={a.id} /><span>{a.name}</span>
            </button>
          ))}
        </div>
        {error && <div className="error">{error}</div>}
        {conflict && (
          <div className="warn">
            {conflict}
            <button type="button" className="btn small" onClick={() => submit(true)}>Replace it</button>
          </div>
        )}
        <div className="row end">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create agent'}</button>
        </div>
      </form>
    </div>
  );
}
