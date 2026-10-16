// Agentix — adapter registry
import type { AgentAdapter } from './types.ts';
import { mockAdapter } from './mock.ts';
import { codexAdapter } from './codex.ts';
import { opencodeAdapter } from './opencode.ts';
import { claudeAdapter } from './claude.ts';

const adapters: Record<string, AgentAdapter> = {
  mock: mockAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  claude: claudeAdapter,
};

export function getAdapter(kind: string): AgentAdapter | undefined {
  return adapters[kind];
}

export function getAllAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}

export function getAdapterNames(): string[] {
  return Object.keys(adapters);
}
