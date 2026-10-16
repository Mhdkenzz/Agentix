// Agentix — mock adapter (no external dependencies)
import type { AgentEvent } from '../../shared/src/types.ts';
import type { AgentAdapter, AdapterContext } from './types';

const TOOL_NAMES = [
  'reading README.md', 'editing src/app.ts', 'running npm test',
  'checking docs/', 'building project', 'reviewing code',
  'writing unit tests', 'updating config', 'refactoring utils',
  'debugging issue', 'deploying to staging', 'checking logs',
];

export const mockAdapter: AgentAdapter = {
  kind: 'mock',

  async detect() {
    return { installed: true, version: 'mock' };
  },

  async send(ctx: AdapterContext, prompt: string) {
    // Update status to thinking
    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'thinking', data: { status: 'thinking', activity: 'thinking...' } });

    // Simulate a believable sequence over ~5 seconds
    const totalSteps = 8;
    for (let i = 0; i < totalSteps; i++) {
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 300));

      if (i < totalSteps - 1) {
        // Emit tool events
        const tool = TOOL_NAMES[i % TOOL_NAMES.length];
        ctx.emit({ agentId: ctx.agent.id, type: 'tool', text: tool, data: { tool, progress: `${i + 1}/${totalSteps}` } });
        ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'working', data: { status: 'working', activity: tool } });
      } else {
        // Last step: emit output and go idle
        const output = `Done: ${prompt}\n\nStep ${i + 1}/${totalSteps} completed. Mock agent finished successfully.`;
        ctx.emit({ agentId: ctx.agent.id, type: 'output', text: output });
        ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'idle', data: { status: 'idle', activity: 'idle' } });
      }
    }
  },

  async interrupt(ctx: AdapterContext) {
    ctx.emit({ agentId: ctx.agent.id, type: 'status', text: 'stopped', data: { status: 'stopped', activity: 'interrupted' } });
  },
};
