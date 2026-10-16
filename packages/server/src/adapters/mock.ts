// Agentix — mock adapter (no external dependencies)
import type { AgentAdapter } from './types.ts';
import { oneLine } from './proc.ts';

const TOOL_NAMES = [
  'reading README.md', 'editing src/app.ts', 'running npm test',
  'checking docs/', 'building project', 'reviewing code',
  'writing unit tests', 'updating config', 'refactoring utils',
  'debugging issue', 'deploying to staging', 'checking logs',
];

// Base delay per step; tests set this low.
const STEP_MS = Number(process.env.AGENTIX_MOCK_STEP_MS) || 500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export const mockAdapter: AgentAdapter = {
  kind: 'mock',

  async detect() {
    return { installed: true, version: 'mock' };
  },

  // A believable sequence over ~5 seconds; stops as soon as the turn is aborted.
  async send(ctx, prompt) {
    const totalSteps = 8;
    for (let i = 0; i < totalSteps; i++) {
      await sleep(STEP_MS + Math.random() * STEP_MS * 0.6, ctx.signal);
      if (ctx.signal.aborted) return;

      if (i < totalSteps - 1) {
        const tool = TOOL_NAMES[i % TOOL_NAMES.length];
        ctx.emit({ type: 'tool', text: tool, data: { tool, progress: `${i + 1}/${totalSteps}` } });
        ctx.emit({ type: 'status', text: 'working', data: { status: 'working', activity: tool } });
      } else {
        // Lines of the prompt that start with "say: " are repeated verbatim, so tests and demos can make a
        // mock coordinator or CEO issue @@ commands. Everything else is echoed on one line.
        const said = prompt.split('\n').filter(l => l.startsWith('say: ')).map(l => l.slice(5));
        ctx.emit({ type: 'output', text: [`Done: ${oneLine(prompt, 4000)}`, ...said, '', `Step ${i + 1}/${totalSteps} completed. Mock agent finished successfully.`].join('\n') });
      }
    }
  },
};
