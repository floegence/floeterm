import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('release metadata keeps terminal-go and terminal-web on one version', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/check_release_version_consistency.mjs'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  assert.match(stdout, /0\.17\.0/);
});
