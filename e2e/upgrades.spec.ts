// Worktrees, the task board and the usage meter, through the dashboard.
// A codex worker (the fake appends a line to app.js each turn) works in a git repo, so it gets its own
// branch; its task moves along the board on its own, its tokens show up, and Merge lands its change.
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

const nav = (page: Page, name: string) => page.locator('nav.topbar').getByRole('link', { name, exact: true });
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', ...args], { encoding: 'utf8' }).trim();

let repo = '';
let vega = '';

test('a worker in a git repo gets its own branch; its task moves to review; its tokens are counted', async ({ page, request }) => {
  expect((await request.put('/api/settings', { data: { setupDone: true } })).ok()).toBeTruthy();
  repo = mkdtempSync(join(tmpdir(), 'agentix-e2e-repo-'));
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'app.js'), '// app\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');

  const res = await request.post('/api/agents', { data: { kind: 'codex', name: 'Vega', cwd: repo } });
  expect(res.status()).toBe(201);
  const { agent } = await res.json();
  vega = agent.id;
  expect(agent.worktree.branch).toMatch(/^agentix\/vega-/);
  expect(agent.cwd).not.toBe(repo);

  // Add a task for Vega on the board.
  await page.goto('/tasks');
  const board = page.locator('.page.tasks');
  await board.getByPlaceholder(/New task/).fill('Add a footer to app.js');
  await board.getByLabel('Owner', { exact: true }).selectOption({ label: 'Vega' });
  await board.getByRole('button', { name: 'Add task' }).click();
  const todo = board.locator('.col-todo .task').filter({ hasText: 'Add a footer to app.js' });
  await expect(todo).toBeVisible();
  await expect(todo).toContainText('Vega');

  // Vega works on it: the task goes to doing, then to review when the turn ends.
  expect((await request.post(`/api/agents/${vega}/steer`, { data: { text: 'Add the footer', from: 'user' } })).ok()).toBeTruthy();
  await expect(board.locator('.col-review .task').filter({ hasText: 'Add a footer to app.js' })).toBeVisible();

  // The fake codex reports 1200 in + 300 out per turn.
  await expect(page.locator('nav.topbar .c-tokens')).toContainText('tokens today');
  await nav(page, 'Agents').click();
  const row = page.locator('table.table tbody tr').filter({ has: page.locator('input[value="Vega"]') });
  await expect(row).toContainText('1.5k');
});

test('the agent panel shows the branch diff, and Merge brings the change into the repo', async ({ page }) => {
  await page.goto('/agents');
  const row = page.locator('table.table tbody tr').filter({ has: page.locator('input[value="Vega"]') });
  await row.getByRole('button', { name: 'Watch' }).click();
  const panel = page.locator('.panel');
  const wt = panel.locator('.worktree');
  await expect(wt).toContainText('agentix/vega-');
  await expect(wt).toContainText('1 file changed');
  await expect(panel.locator('.panel-tasks')).toContainText('Add a footer to app.js');

  await wt.getByRole('button', { name: 'Diff' }).click();
  const diff = page.locator('.diff-modal');
  await expect(diff.locator('.diff-files')).toContainText('M app.js');
  await expect(diff.locator('.diff .d-add')).toContainText('// added by codex');
  await diff.getByRole('button', { name: 'Close' }).click();

  // The repo has not changed yet; Merge brings the worker's commit in.
  expect(readFileSync(join(repo, 'app.js'), 'utf8')).toBe('// app\n');
  await wt.getByRole('button', { name: 'Merge' }).click();
  await expect(wt).toContainText('merged into');
  await expect(wt).toContainText('no changes');
  expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('// added by codex');
  expect(git(repo, 'log', '-1', '--pretty=%s')).toContain('Vega');
});

test('New agent: pick a model (and reasoning level) from the CLI\'s list, and change it later', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New agent' }).click();
  const modal = page.locator('.modal');
  await modal.getByLabel('Agent', { exact: true }).selectOption('codex');
  await modal.getByLabel('Name', { exact: true }).fill('Orion');
  const picker = modal.locator('.model-picker');
  const select = picker.locator('select').first();
  // The fake codex lists two models (a hidden one is left out), plus "CLI default".
  await expect(select.locator('option')).toHaveText(['CLI default (gpt-5.6-luna:high)', 'GPT-6.1-Sol · gpt-6.1-sol', 'GPT-6-Astra · gpt-6-astra']);
  await select.selectOption('gpt-6.1-sol');
  await expect(picker).toContainText('Latest workhorse model');
  await picker.getByLabel('Reasoning level').selectOption('high');
  await modal.getByRole('button', { name: 'Create agent' }).click();

  const orion = (await (await request.get('/api/agents')).json()).agents.find((a: any) => a.name === 'Orion');
  expect(orion.model).toBe('gpt-6.1-sol:high');

  // The panel shows the model; change it to another available model.
  const panel = page.locator('.panel');
  await expect(panel.locator('.model-tag')).toHaveText('gpt-6.1-sol:high');
  await panel.locator('.model-tag').click();
  const change = page.locator('.model-modal');
  await change.locator('select').first().selectOption('gpt-6-astra');
  await change.getByRole('button', { name: 'Save' }).click();
  await expect(panel.locator('.model-tag')).toHaveText('gpt-6-astra');
});

test('sessions: active sessions can be selected, and a new session dialog opens', async ({ page }) => {
  await page.goto('/');
  const sessions = page.getByRole('combobox', { name: 'Active sessions' });
  await expect(sessions).toBeEnabled();
  await expect(sessions.locator('option')).not.toHaveCount(1);

  await page.getByRole('button', { name: '+ New session' }).click();
  const modal = page.locator('.session-modal');
  await expect(modal).toContainText('Start a fresh native conversation');
  await expect(modal.getByRole('combobox', { name: 'Agent', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancel' }).click();

  await sessions.selectOption({ index: 1 });
  await expect(page.locator('.panel')).toBeVisible();
});
