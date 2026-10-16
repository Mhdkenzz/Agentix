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
