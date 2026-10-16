// Agentix — adapter interface

import type { Agent, AgentEvent } from '../../shared/src/types.ts';

export interface AdapterContext {
  agent: Agent;
  emit(e: Omit<AgentEvent, 'id' | 'ts' | 'agentId'>): void;
  setNativeSessionId(id: string): void;
}

export interface AgentAdapter {
  kind: string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  send(ctx: AdapterContext, prompt: string): Promise<void>;
  interrupt(ctx: AdapterContext): Promise<void>;
}
