// AGENTS.md: each role gets "Everyone" plus its own section, once per session; kenz's copy wins over the default.
import { TMP, WORK, waitFor } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventBus } from '../src/bus.ts';
import { SessionManager } from '../src/sessions.ts';
import { roleGuide, sections, DEFAULT_AGENTS_MD } from '../src/roles.ts';

const MD = '# Team\nintro\n\n## Everyone\nBe brief.\n\n## CEO\nTalk to kenz.\n\n## Coordinator\nPlan the work.\n\n## Worker\nRun the tests.\n';

test('each role gets the Everyone section plus its own', () => {
  assert.deepEqual([...sections(MD).keys()], ['everyone', 'ceo', 'coordinator', 'worker']);
  const worker = roleGuide('worker', MD);
  assert.match(worker, /^\[AGENTS\.MD\] How to work as the worker:\nBe brief\.\n\nRun the tests\.$/);
  assert.ok(!worker.includes('Plan the work'));
  assert.match(roleGuide('ceo', MD), /Be brief\.\n\nTalk to kenz\./);
  assert.equal(roleGuide('worker', '# nothing here'), '');
});

test('the default AGENTS.md has a section for every role', () => {
  const s = sections(readFileSync(DEFAULT_AGENTS_MD, 'utf8'));
  for (const name of ['everyone', 'ceo', 'coordinator', 'worker']) assert.ok(s.get(name), `## ${name}`);
});

test('a worker gets its AGENTS.md guidance on its first turn only; kenz\'s copy wins', async () => {
  const home = process.env.AGENTIX_HOME!;
  writeFileSync(join(home, 'AGENTS.md'), MD);
  rmSync(join(TMP, 'codex.args'), { force: true });
  const sm = new SessionManager(new EventBus());
  try {
    const w = await sm.createAgent('codex', { name: 'Rune', cwd: WORK, prompt: 'first' });
    await waitFor(() => !sm.isRunning(w.id) && sm.getAgent(w.id)?.nativeSessionId, 5000, 'first turn');
    await sm.steerAgent(w.id, 'second');
    await waitFor(() => !sm.isRunning(w.id) && readFileSync(join(TMP, 'codex.args'), 'utf8').includes('second'), 5000, 'second turn');
    const raw = readFileSync(join(TMP, 'codex.args'), 'utf8');
    assert.equal(raw.split('Run the tests.').length - 1, 1, 'guidance sent once');
    assert.match(raw, /How to work as the worker:[\s\S]*Run the tests\.[\s\S]*first/);
    assert.ok(!raw.includes('Plan the work'), 'not another role\'s section');
  } finally {
    await sm.shutdown();
    writeFileSync(join(home, 'AGENTS.md'), '');
  }
});
