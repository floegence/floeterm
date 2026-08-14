import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./ci.yml', import.meta.url);

test('native semantic CI covers active macOS and Linux x64 and arm64 runners', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  for (const runner of ['macos-15-intel', 'macos-15', 'ubuntu-22.04', 'ubuntu-24.04-arm']) {
    assert.match(workflow, new RegExp(`- ${runner.replace('.', '\\.')}(?:\\s|$)`));
  }
  assert.doesNotMatch(workflow, /macos-(?:13|14)(?:\s|$)/);
});
