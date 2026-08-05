import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('./release.yml', import.meta.url);

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
