import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./release.yml', import.meta.url);
const terminalWebPackagePath = new URL('../../terminal-web/package.json', import.meta.url);

test('top-level release tags publish only the semantic terminal web package', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*"/);
  assert.match(workflow, /npm-publish-terminal-web:/);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.doesNotMatch(workflow, /beamterm|renderer|wasm-pack/i);
});

test('semantic-only release publishes terminal-web 0.15.1', async () => {
  const manifest = JSON.parse(await readFile(terminalWebPackagePath, 'utf8'));

  assert.equal(manifest.name, '@floegence/floeterm-terminal-web');
  assert.equal(manifest.version, '0.15.1');
  assert.deepEqual(manifest.dependencies, {});
});
