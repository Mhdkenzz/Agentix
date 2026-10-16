// Agentix — adapter interface

import type { Agent, AgentEvent } from '../../../shared/src/types.ts';

export interface AdapterContext {
  agent: Agent;
  /** push a normalized event: output, tool, error, or status with `data.activity` */
  emit(e: Omit<AgentEvent, 'id' | 'ts' | 'agentId'>): void;
  setNativeSessionId(id: string): void;
  /** aborted when the turn is interrupted or steered; the adapter must stop promptly */
  signal: AbortSignal;
  /** role instructions (coordinator/CEO) to give before the prompt; set once per session */
  instructions?: string;
  /** extra environment variables for the CLI process */
  env?: Record<string, string>;
}

/** The prompt with role instructions in front, for CLIs without a separate system-prompt flag. */
export function withInstructions(ctx: AdapterContext, prompt: string): string {
  return ctx.instructions ? `${ctx.instructions}\n\n---\n\n${prompt}` : prompt;
}

export interface AgentAdapter {
  kind: string;
  /** true if the CLI is installed, plus its version */
  detect(): Promise<{ installed: boolean; version?: string }>;
  /**
   * Run one turn: start a new session, or continue `agent.nativeSessionId`.
   * Resolves when the turn ends and rejects on failure. The session manager
   * owns the thinking/idle/stopped/error transitions; adapters only report
   * output, tools and the current activity.
   */
  send(ctx: AdapterContext, prompt: string): Promise<void>;
}
