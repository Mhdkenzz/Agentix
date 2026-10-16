// Agentix — adapter registry
import type { AgentAdapter } from './types.ts';
import { mockAdapter } from './mock.ts';
import { codexAdapter } from './codex.ts';
import { opencodeAdapter } from './opencode.ts';
import { claudeAdapter } from './claude.ts';
import { piAdapter } from './pi.ts';
import { hermesAdapter } from './hermes.ts';
import { geminiAdapter } from './gemini.ts';
import { aiderAdapter } from './aider.ts';
import { gooseAdapter } from './goose.ts';

const adapters: Record<string, AgentAdapter> = {
  mock: mockAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  claude: claudeAdapter,
  pi: piAdapter,
  hermes: hermesAdapter,
  gemini: geminiAdapter,
  aider: aiderAdapter,
  goose: gooseAdapter,
};

/** The mock adapter is for tests only and stays hidden unless AGENTIX_MOCK=1. */
export function mockEnabled(): boolean {
  return process.env.AGENTIX_MOCK === '1';
}

export function getAdapter(kind: string): AgentAdapter | undefined {
  if (kind === 'mock' && !mockEnabled()) return undefined;
  return adapters[kind];
}

export function getAllAdapters(): AgentAdapter[] {
  return getAdapterNames().map(k => adapters[k]);
}

export function getAdapterNames(): string[] {
  return Object.keys(adapters).filter(k => k !== 'mock' || mockEnabled());
}
