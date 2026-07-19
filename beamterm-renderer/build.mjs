import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });

const result = spawnSync('wasm-pack', [
  'build',
  '--target', 'bundler',
  '--out-dir', 'dist',
  '--out-name', 'beamterm_renderer',
  '--no-pack',
  '--release',
  '.',
  '--locked',
  '--features', 'js-api',
], {
  cwd: new URL('.', import.meta.url),
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

rmSync(new URL('./dist/.gitignore', import.meta.url), { force: true });
