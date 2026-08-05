import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('package metadata identifies the provenance repository and directory', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/floegence/floeterm.git',
    directory: 'beamterm-renderer',
  });
});
