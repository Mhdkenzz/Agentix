// Dashboard preferences, kept in this browser.
export interface Settings {
  defaultKind: string;
  defaultCwd: string;
  voice: boolean;
  voiceName: string;
}

const KEY = 'agentix.settings';
const DEFAULTS: Settings = { defaultKind: 'codex', defaultCwd: '', voice: true, voiceName: '' };

export function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
