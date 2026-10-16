// Picking a model: listing each CLI's models, passing the choice to the CLI, changing it later.
import { TMP, BIN, WORK, fakeCalls, waitFor } from './helpers.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/index.ts';
import { parseCodexModels, parseOpencodeModels, parsePiModels, tomlTopModel, hermesDefaultModel } from '../src/adapters/models.ts';
import { codexArgs } from '../src/adapters/codex.ts';
import { claudeArgs } from '../src/adapters/claude.ts';
import { opencodeArgs } from '../src/adapters/opencode.ts';
import { piArgs } from '../src/adapters/pi.ts';
import { hermesArgs } from '../src/adapters/hermes.ts';

const { server, sessionManager: sm, port } = await startServer(0);
const base = `http://127.0.0.1:${port}`;
after(async () => { await sm.shutdown(); server.closeAllConnections(); server.close(); });
const json = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

// Trimmed real output from kenz's machine (codex-cli 0.162.1, opencode 2.0.30, pi 1.3.0).
const CODEX_MODELS = JSON.stringify({ models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence.', visibility: 'list', priority: 2, model_messages: 'long text' },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 5 },
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model.', visibility: 'list', priority: 1,
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
] });
const OPENCODE_MODELS = 'ifm/IFM/K2-Horizon-375B-A23B\nlmstudio/qwen/qwen3.6-35b-a3b\nopencode/big-pickle\nopenrouter/~anthropic/claude-opus-latest\n';
const PI_MODELS = `provider    model                                context  max-out  thinking  images
openrouter  ~anthropic/claude-opus-latest        1M       128K     yes       yes
openrouter  amazon/nova-micro-v1                 128K     5.1K     no        no
`;

test('model lists are read from each CLI\'s own output', () => {
  assert.deepEqual(parseCodexModels(CODEX_MODELS).map(m => m.id), ['gpt-6.1-sol', 'gpt-6-astra'], 'hidden models dropped, by priority');
  assert.equal(parseCodexModels(CODEX_MODELS)[0].label, 'GPT-6.1-Sol');
  assert.deepEqual(parseCodexModels(CODEX_MODELS)[0].efforts, ['low', 'high', 'ultra']);
  assert.equal(parseCodexModels(CODEX_MODELS)[0].defaultEffort, 'low');
  assert.deepEqual(parseOpencodeModels(OPENCODE_MODELS).map(m => [m.group, m.id]), [
    ['ifm', 'ifm/IFM/K2-Horizon-375B-A23B'], ['lmstudio', 'lmstudio/qwen/qwen3.6-35b-a3b'],
    ['opencode', 'opencode/big-pickle'], ['openrouter', 'openrouter/~anthropic/claude-opus-latest'],
  ]);
  assert.deepEqual(parsePiModels(PI_MODELS).map(m => m.id), ['openrouter/~anthropic/claude-opus-latest', 'openrouter/amazon/nova-micro-v1']);
  assert.equal(tomlTopModel('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "high"\n[profiles.x]\nmodel = "other"\n'), 'gpt-5.6-luna');
  assert.equal(tomlTopModel('[profiles.x]\nmodel = "other"\n'), undefined);
  assert.equal(hermesDefaultModel('model:\n  default: "IFM/K2-Horizon-375B-A23B"\n  provider: custom:k2-horizon\nother: 1\n'), 'IFM/K2-Horizon-375B-A23B');
});

test('the chosen model goes to each CLI\'s model flag', () => {
  assert.deepEqual(codexArgs('/w', 'hi', undefined, 'gpt-6-sol').slice(-4), ['-c', 'model="gpt-6-sol"', '--', 'hi']);
  assert.deepEqual(codexArgs('/w', 'hi', 'th-1', 'gpt-6-sol').slice(-5), ['-c', 'model="gpt-6-sol"', '--', 'th-1', 'hi']);
  assert.deepEqual(claudeArgs('hi', undefined, 'opus').slice(-4), ['--model', 'opus', '--', 'hi']);
  assert.ok(opencodeArgs('hi', undefined, 'opencode/big-pickle').join(' ').includes('-m opencode/big-pickle'));
  assert.ok(piArgs('hi', undefined, undefined, 'openrouter/amazon/nova-micro-v1').join(' ').includes('--model openrouter/amazon/nova-micro-v1'));
  assert.ok(hermesArgs('hi', undefined, 'IFM/K2').join(' ').includes('-m IFM/K2'));
  assert.ok(!codexArgs('/w', 'hi').includes('-c'), 'no model: the CLI default');
  assert.deepEqual(codexArgs('/w', 'hi', undefined, 'gpt-6-sol:high').slice(-6), ['-c', 'model="gpt-6-sol"', '-c', 'model_reasoning_effort="high"', '--', 'hi']);
});

test('GET /api/adapters/:kind/models lists models, with the configured default', async () => {
  const home = join(TMP, 'userhome');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "high"\n');
  process.env.HOME = home;
  writeFileSync(join(BIN, 'codex'), `#!/bin/bash
if [ "$1 $2" = "debug models" ]; then cat <<'EOF'
${CODEX_MODELS}
EOF
exit 0; fi
echo '{"type":"thread.started","thread_id":"th-m"}'
echo '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}'
{ printf '%s\\0' "$@"; printf '\\n'; } >> "${join(TMP, 'codex.args')}"
`);
  chmodSync(join(BIN, 'codex'), 0o755);

  const r = await json('/api/adapters/codex/models');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.models.map((m: any) => m.id), ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.equal(r.body.current, 'gpt-5.6-luna:high');

  assert.deepEqual((await json('/api/adapters/claude/models')).body.models.map((m: any) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  const gemini = await json('/api/adapters/gemini/models');
  assert.deepEqual(gemini.body.models, [], 'no model list');
  assert.match(gemini.body.error, /does not expose an available model list/i);
  assert.equal((await json('/api/adapters/nope/models')).status, 404);
});

test('an agent created with a model runs with it; the model can be changed or cleared later', async () => {
  const bad = await json('/api/agents', 'POST', { kind: 'codex', name: 'Bad', cwd: WORK, model: 'x" --danger' });
  assert.equal(bad.status, 400);
  const unavailable = await json('/api/agents', 'POST', { kind: 'codex', name: 'Unavailable', cwd: WORK, model: 'gpt-not-listed' });
  assert.equal(unavailable.status, 400);
  assert.match(unavailable.body.error, /not in codex.*available model list/i);
  const badEffort = await json('/api/agents', 'POST', { kind: 'codex', name: 'Bad effort', cwd: WORK, model: 'gpt-6.1-sol:nope' });
  assert.equal(badEffort.status, 400);
  const noList = await json('/api/agents', 'POST', { kind: 'gemini', name: 'Default only', cwd: WORK, model: 'gemini-2.5-pro' });
  assert.equal(noList.status, 400);

  const { status, body } = await json('/api/agents', 'POST', { kind: 'codex', name: 'Sol', cwd: WORK, model: 'gpt-6-astra', prompt: 'hi' });
  assert.equal(status, 201);
  assert.equal(body.agent.model, 'gpt-6-astra');
  const id = body.agent.id;
  await waitFor(() => fakeCalls('codex').some(c => c.includes('model="gpt-6-astra"')), 5000, 'codex called with the model');
  await waitFor(() => !sm.isRunning(id), 5000, 'turn done');

  const p = await json(`/api/agents/${id}`, 'PATCH', { model: 'gpt-6.1-sol' });
  assert.equal(p.status, 200);
  assert.equal(p.body.agent.model, 'gpt-6.1-sol');
  assert.equal(sm.getAgent(id)?.model, 'gpt-6.1-sol', 'stored');
  const patchUnavailable = await json(`/api/agents/${id}`, 'PATCH', { model: 'gpt-not-listed' });
  assert.equal(patchUnavailable.status, 400);
  const cleared = await json(`/api/agents/${id}`, 'PATCH', { model: '' });
  assert.equal(cleared.body.agent.model, undefined, 'empty = back to the CLI default');
});
