// Browser tests: the real server and the built dashboard (packages/web/dist), driven through Chromium.
// Agent CLIs are the fakes in e2e/fakebin, so no model is called. Run with `npm run e2e`.
import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const PORT = Number(process.env.E2E_PORT) || 4391;
/** A fresh AGENTIX_HOME for each run; e2e/start-server.mjs wipes it before the server starts. */
const HOME = process.env.E2E_AGENTIX_HOME || join(tmpdir(), 'agentix-e2e');
const FAKEBIN = join(__dirname, 'e2e', 'fakebin');

export default defineConfig({
  testDir: './e2e',
  // One server with one shared state: tests run in order, one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Locally: PW_CHROMIUM=/path/to/chrome when Playwright's own browser isn't installed.
          ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
          // Software WebGL, so the office's 3D scene renders in headless Chromium.
          args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
  webServer: {
    command: 'node e2e/start-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/agents`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      AGENTIX_HOME: HOME,
      AGENTIX_PORT: String(PORT),
      AGENTIX_UPDATE_DELAY_MS: '300',
      PATH: `${FAKEBIN}${delimiter}${process.env.PATH ?? ''}`,
    },
  },
});
