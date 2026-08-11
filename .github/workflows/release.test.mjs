import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./release.yml', import.meta.url);
const terminalWebPackagePath = new URL('../../terminal-web/package.json', import.meta.url);

test('manual renderer releases skip terminal-web while tags retain the full chain', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+target:/);
  assert.match(workflow, /options:\s*\n\s+- all\s*\n\s+- renderer/);
  assert.match(workflow, /default:\s*all/);
  assert.match(
    workflow,
    /npm-publish-terminal-web:[\s\S]*?if:\s*github\.event_name != 'workflow_dispatch' \|\| inputs\.target == 'all'/,
  );
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*"/);
});

test('checkpoint release publishes the terminal web minor version', async () => {
  const manifest = JSON.parse(await readFile(terminalWebPackagePath, 'utf8'));

  assert.equal(manifest.name, '@floegence/floeterm-terminal-web');
  assert.equal(manifest.version, '0.14.0');
});
