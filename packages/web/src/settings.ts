// Dashboard preferences kept in this browser (server-wide ones live in /api/settings).
export interface Settings {
  voice: boolean;
  voiceName: string;
}

const KEY = 'agentix.settings';
const DEFAULTS: Settings = { voice: true, voiceName: '' };

export function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}
