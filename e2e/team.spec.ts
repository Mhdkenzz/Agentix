// The main flows, in order, against one server: setup builds the team, then the CEO chat, the shared
// context, History (with a removed agent), the office and the agents table.
// The fake `claude` (e2e/fakebin) answers the coordinator's first task by spawning Rook and Juno (codex)
// and saving a note; every other turn it says "Hi kenz. The team is set up and working."
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** A top-bar page link; matched by its exact name so more pages can join the nav. */
const nav = (page: Page, name: string) => page.locator('nav.topbar').getByRole('link', { name, exact: true });

interface ApiAgent { id: string; name: string; kind: string; role: string; status: string }
async function agents(request: APIRequestContext): Promise<ApiAgent[]> {
  const res = await request.get('/api/agents');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).agents;
}

test('first launch: setup finds the CLIs and the coordinator builds the team', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  const setup = page.locator('.page.setup');
  await expect(setup.getByRole('heading', { name: 'Set up Agentix' })).toBeVisible();

  // Step 1: both fakes on PATH are found and usable.
  for (const name of ['Codex', 'Claude Code']) {
    const row = setup.locator('.found-row').filter({ has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) });
    await expect(row).toContainText('can join the team');
  }
  await expect(setup.locator('.found-row').filter({ hasText: 'Claude Code' })).toContainText('2.1.301');
  await expect(setup.locator('.found-row').filter({ hasText: 'Codex' })).toContainText('codex-cli 0.162.1');

  // Step 2: "You + an agent", Claude Code coordinator named Nimbus, plus a Claude Code CEO.
  await setup.getByRole('button', { name: /^You \+ an agent/ }).click();
  await setup.getByLabel('Coordinator agent').selectOption('claude');
  await setup.getByLabel('Its name').fill('Nimbus');
  await setup.getByLabel(/Also hire a CEO/).check();
  await setup.getByLabel('CEO agent').selectOption('claude');

  // Step 3: the first task.
  await setup.locator('textarea').fill('Build a small todo web app with tests.');
  await setup.getByRole('button', { name: 'Create the team' }).click();

  await expect(page).toHaveURL(/\/ceo$/);
  // The CEO's sidebar: CEO, Nimbus, and the two workers Nimbus spawned.
  const team = page.locator('.ceo-side .team');
  await expect(team.locator('.team-row')).toHaveCount(4);
  await expect(team.locator('.team-row').filter({ hasText: 'Nimbus' }).first()).toContainText('coordinator');
  await expect(team.locator('.team-row').filter({ hasText: 'Rook' }).filter({ hasText: 'codex' }).first()).toBeVisible();
  await expect(team.locator('.team-row').filter({ hasText: 'Juno' }).filter({ hasText: 'codex' }).first()).toBeVisible();

  const list = await agents(request);
  expect(list.map(a => a.role).sort()).toEqual(['ceo', 'coordinator', 'worker', 'worker']);
  expect(list.find(a => a.role === 'coordinator')).toMatchObject({ name: 'Nimbus', kind: 'claude' });
  expect(list.find(a => a.role === 'ceo')).toMatchObject({ kind: 'claude' });
});

test('CEO chat: a reply arrives, and Clear empties the chat', async ({ page }) => {
  await page.goto('/ceo');
  const chat = page.locator('.ceo .chat');
  const talk = page.locator('form.talk');
  await talk.getByRole('textbox').fill('hello');
  await talk.getByRole('button', { name: 'Send' }).click();

  await expect(chat.locator('.from-you')).toContainText('hello');
  await expect(chat.locator('.from-ceo').filter({ hasText: 'team is set up' })).toBeVisible();

  page.on('dialog', d => d.accept());
  await page.locator('.ceo-head').getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(chat).toContainText('Session cleared');
  await expect(chat).not.toContainText('team is set up');
  await expect(chat).not.toContainText('hello');
});

test('Context: the saved note is listed, the brief saves, search finds hits', async ({ page }) => {
  await page.goto('/');
  await nav(page, 'Context').click();
  await expect(page).toHaveURL(/\/context$/);
  const ctx = page.locator('.page.context');

  // Saved by the coordinator with @@remember.
  await expect(ctx.locator('.notes .note-text').filter({ hasText: 'The todo app uses plain HTML + JS' })).toBeVisible();

  const brief = 'Ship a tiny todo app. Keep it dependency free.';
  await ctx.locator('textarea.brief').fill(brief);
  await ctx.getByRole('button', { name: 'Save brief' }).click();
  await expect(ctx.getByText('Saved the brief.')).toBeVisible();
  await page.reload();
  await expect(page.locator('.page.context textarea.brief')).toHaveValue(brief);

  await page.locator('.page.context input.search').fill('todo app');
  await expect(page.locator('.page.context .hits .hit').first()).toBeVisible();
  await expect(page.locator('.page.context .hits')).toContainText('The todo app uses plain HTML + JS');
});

test('History: a removed agent stays listed with its events', async ({ page, request }) => {
  const rook = (await agents(request)).find(a => a.name === 'Rook' && a.role === 'worker');
  expect(rook, 'Rook was spawned by the coordinator').toBeTruthy();
  // Its turn is quick; removing it either way must keep its history.
  const del = await request.delete(`/api/agents/${rook!.id}`);
  expect(del.status()).toBe(200);
  expect((await agents(request)).some(a => a.id === rook!.id)).toBe(false);

  await page.goto('/');
  await nav(page, 'History').click();
  await expect(page).toHaveURL(/\/history/);

  const entry = page.locator('.hist-agents .hist-agent')
    .filter({ hasText: 'Rook' })
    .filter({ has: page.locator('.removed-tag') });
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.removed-tag')).toHaveText('removed');

  await entry.click();
  await expect(page).toHaveURL(new RegExp(`agent=${rook!.id}`));
  await expect(page.locator('.hist-main .resume')).toContainText('removed');
  const log = page.locator('.hist-log');
  await expect(log.locator('.ev').first()).toBeVisible();
  await expect(log).toContainText('Build the todo app');
  await expect(log).toContainText('Scaffolded index.html and app.js.');
});

test('Office renders without page errors, and Agents lists the team', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`${e.name}: ${e.message}`));

  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  const canvas = page.locator('.route-office canvas');
  await expect(canvas).toBeVisible();
  // three.js needs WebGL2; this returns the context the scene already created.
  expect(await canvas.evaluate((c: HTMLCanvasElement) => c.getContext('webgl2') !== null)).toBe(true);
  await expect(page.locator('.office .legend')).toContainText('thinking');
  // Give the scene a few frames to render (and fail, if it is going to).
  await page.waitForTimeout(1500);

  await nav(page, 'Agents').click();
  await expect(page).toHaveURL(/\/agents$/);
  const rows = page.locator('table.table tbody tr');
  for (const name of ['Nimbus', 'Juno']) {
    await expect(rows.filter({ has: page.locator(`input[value="${name}"]`) })).toHaveCount(1);
  }
  await expect(rows).toHaveCount(3); // CEO, Nimbus, Juno (Rook was removed)
  await expect(rows.filter({ hasText: 'codex' })).toHaveCount(1);

  // Back to the office (it stays mounted) and around once more.
  await nav(page, 'Office').click();
  await expect(page.locator('.route-office canvas')).toBeVisible();
  await page.waitForTimeout(500);

  expect(errors).toEqual([]);
});
