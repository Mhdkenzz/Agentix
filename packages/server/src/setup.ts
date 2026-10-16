// Agentix — first-run setup: find the agent CLIs installed on this machine.
// Runs scripts/scan_clis.py (python3, python or py); without Python, a smaller PATH-only scan in Node.
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter } from './adapters/index.ts';

export interface FoundCli {
  kind: string;
  name: string;
  path: string;
  version: string;
  /** `--version` ran without timing out */
  runs: boolean;
  on_path: boolean;
  all_paths: string[];
  /** Agentix has an adapter for it, so it can be a coordinator, CEO or worker */
  supported: boolean;
}

export interface ScanResult {
  scanner: 'python' | 'node';
  platform: string;
  found: FoundCli[];
}

type RawScan = { platform: string; found: Omit<FoundCli, 'supported'>[] };

const SCRIPT = fileURLToPath(new URL('../scripts/scan_clis.py', import.meta.url));
const PYTHONS = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];

const NAMES: Record<string, string> = {
  codex: 'Codex', opencode: 'OpenCode', claude: 'Claude Code', pi: 'Pi', hermes: 'Hermes', gemini: 'Gemini CLI',
  aider: 'Aider', goose: 'Goose', 'cursor-agent': 'Cursor Agent', qwen: 'Qwen Code', amp: 'Amp', crush: 'Crush',
  copilot: 'GitHub Copilot CLI',
};

function run(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? null : String(stdout || stderr));
    });
  });
}

async function scanWithPython(): Promise<RawScan | null> {
  if (!existsSync(SCRIPT)) return null;
  for (const py of PYTHONS) {
    const out = await run(py, [SCRIPT], 60_000);
    if (!out) continue;
    try { return JSON.parse(out); } catch { /* not our JSON, try the next python */ }
  }
  return null;
}

async function scanWithNode(): Promise<RawScan> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  const found: Omit<FoundCli, 'supported'>[] = [];
  for (const [kind, name] of Object.entries(NAMES)) {
    const paths: string[] = [];
    for (const d of dirs) for (const e of exts) {
      const p = join(d, kind + e);
      try { if (statSync(p).isFile() && !paths.includes(p)) paths.push(p); } catch { /* not there */ }
    }
    if (!paths.length) continue;
    const out = await run(paths[0], ['--version'], 8_000);
    found.push({ kind, name, path: paths[0], version: out?.trim().split('\n')[0]?.slice(0, 120) ?? '', runs: out != null, on_path: true, all_paths: paths });
  }
  return { platform: process.platform, found };
}

/** Every agent CLI on this machine, supported ones (with an Agentix adapter) first. */
export async function scanClis(): Promise<ScanResult> {
  const py = await scanWithPython();
  const res = py ?? await scanWithNode();
  const found = (res.found ?? []).map(f => ({ ...f, supported: Boolean(getAdapter(f.kind)) && f.kind !== 'mock' }));
  found.sort((a, b) => Number(b.supported) - Number(a.supported));
  return { scanner: py ? 'python' : 'node', platform: res.platform, found };
}
