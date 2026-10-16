// Starts the Agentix server for the browser tests on a wiped AGENTIX_HOME (set by playwright.config.ts).
// The wipe lives here, not in the config, because Playwright loads the config again in every worker.
import { rmSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = process.env.AGENTIX_HOME;
// Never wipe a real Agentix home: the test home's folder name must mention e2e.
if (!home || !/e2e/i.test(basename(resolve(home)))) {
  console.error(`refusing to wipe AGENTIX_HOME=${home ?? '(unset)'}: its folder name must contain "e2e"`);
  process.exit(1);
}
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const cli = fileURLToPath(new URL('../packages/cli/src/agentix.ts', import.meta.url));
const child = spawn(process.execPath, [cli, 'server'], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
