// Direct working folders, the task board and the usage meter, through the dashboard.
// The fake Codex appends to app.js in the configured folder, and tasks/tokens update in the dashboard.
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

const nav = (page: Page, name: string) => page.locator('.topbar nav[aria-label="Main navigation"]').getByRole('link', { name, exact: true });

let repo = '';

test('a worker uses its configured folder; its task moves to review and its tokens are counted', async ({ page, request }) => {
  expect((await request.put('/api/settings', { data: { setupDone: true } })).ok()).toBeTruthy();
  repo = mkdtempSync(join(tmpdir(), 'agentix-e2e-repo-'));
  writeFileSync(join(repo, 'app.js'), '// app\n');

  const res = await request.post('/api/agents', { data: { kind: 'codex', name: 'Vega', cwd: repo } });
  expect(res.status()).toBe(201);
  const { agent } = await res.json();
  expect(agent.worktree).toBeUndefined();
  expect(agent.cwd).toBe(repo);

  // Add a task for Vega on the board.
  await page.goto('/tasks');
  const board = page.locator('.page.tasks');
  await board.getByPlaceholder(/New task/).fill('Add a footer to app.js');
  await board.getByLabel('Owner', { exact: true }).selectOption({ label: 'Vega' });
  await board.getByRole('button', { name: 'Add task' }).click();

  // The board starts Vega on it: the task goes to doing, then to review when the turn ends.
  const done = board.locator('.col-review .task').filter({ hasText: 'Add a footer to app.js' });
  await expect(done).toBeVisible();
  await expect(done).toContainText('Vega');
  expect(readFileSync(join(repo, 'app.js'), 'utf8')).toContain('// added by codex');

  // The fake codex reports 1200 in + 300 out per turn.
  await expect(page.locator('.topbar .c-tokens')).toContainText('tokens today');
  await nav(page, 'Agents').click();
  const row = page.locator('table.table tbody tr').filter({ has: page.locator('input[value="Vega"]') });
  await expect(row).toContainText('1.5k');
});

test('the agent panel shows the configured working folder and assigned task', async ({ page }) => {
  await page.goto('/agents');
  const row = page.locator('table.table tbody tr').filter({ has: page.locator('input[value="Vega"]') });
  await row.getByRole('button', { name: 'Watch' }).click();
  const panel = page.locator('.panel');
  await expect(panel.locator('.panel-location')).toContainText(repo);
  await expect(panel.locator('.panel-tasks')).toContainText('Add a footer to app.js');
});

test('New agent: pick a model (and reasoning level) from the CLI\'s list, and change it later', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '+ New agent' }).click();
  const modal = page.locator('.modal');
  await modal.getByRole('combobox', { name: /^Agent\b/ }).selectOption('codex');
  await modal.getByLabel('Name', { exact: true }).fill('Orion');
  const picker = modal.locator('.model-picker');
  const select = picker.locator('select').first();
  // The fake codex lists two models (a hidden one is left out), plus "CLI default" (which names the model from ~/.codex/config.toml when there is one).
  await expect(select.locator('option')).toHaveText([/^CLI default\b/, 'GPT-6.1-Sol · gpt-6.1-sol', 'GPT-6-Astra · gpt-6-astra']);
  await select.selectOption('gpt-6.1-sol');
  await expect(picker).toContainText('Latest workhorse model');
  await picker.getByLabel('Reasoning level').selectOption('high');
  await modal.getByRole('button', { name: 'Create agent' }).click();

  // The panel opens only after the server answered the create, so the agent is in the store by now.
  const panel = page.locator('.panel');
  await expect(panel.locator('.model-tag')).toHaveText('gpt-6.1-sol:high');

  const orion = (await (await request.get('/api/agents')).json()).agents.find((a: any) => a.name === 'Orion');
  expect(orion.model).toBe('gpt-6.1-sol:high');

  // The panel shows the model; change it to another available model.
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
  await expect(modal.getByRole('combobox', { name: /^Agent\b/ })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancel' }).click();

  await sessions.selectOption({ index: 1 });
  await expect(page.locator('.panel')).toBeVisible();
});
