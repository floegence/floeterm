import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCliPath = process.env.npm_execpath;

if (!npmCliPath) {
  throw new Error('Package artifact checks must run through npm so npm_execpath is available');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'floeterm-terminal-web-package-'));

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
}

async function runNpm(args, cwd) {
  await run(process.execPath, [npmCliPath, ...args], cwd);
}

try {
  const { stdout } = await execFileAsync(process.execPath, [npmCliPath,
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporaryRoot,
  ], { cwd: packageRoot });
  const [{ filename }] = JSON.parse(stdout);
  const tarballPath = path.join(temporaryRoot, filename);
  const consumerRoot = path.join(temporaryRoot, 'consumer');

  await runNpm(['init', '--yes'], temporaryRoot);
  await runNpm([
    'install',
    '--ignore-scripts',
    '--package-lock=false',
    '--prefer-offline',
    tarballPath,
  ], temporaryRoot);

  await writeFile(path.join(temporaryRoot, 'package.json'), `${JSON.stringify({
    private: true,
    type: 'module',
  }, null, 2)}\n`);
  await run(process.execPath, [
    '--input-type=module',
    '--eval',
    "const api = await import('@floegence/floeterm-terminal-web'); if (typeof api.TerminalCore !== 'function') throw new Error('TerminalCore export is unavailable');",
  ], temporaryRoot);

  await run(process.execPath, ['-e', "require('fs').mkdirSync(process.argv[1])", consumerRoot], temporaryRoot);
  await writeFile(path.join(consumerRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2020',
    },
    include: ['index.mts'],
  }, null, 2)}\n`);
  await writeFile(path.join(consumerRoot, 'index.mts'), `
import {
  TerminalCore,
  preparePagedTerminalHistory,
  preloadTerminalResources,
  type PreparedPagedTerminalHistory,
  type TerminalInitializationPriority,
} from '@floegence/floeterm-terminal-web';

const priority: TerminalInitializationPriority = 'interactive';
const prepared: PreparedPagedTerminalHistory | undefined = undefined;
void [TerminalCore, preparePagedTerminalHistory, preloadTerminalResources, priority, prepared];
`);

  await run(process.execPath, [
    path.join(packageRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--project',
    path.join(consumerRoot, 'tsconfig.json'),
  ], temporaryRoot);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
