import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('starts the product E2E backend with the native semantic engine', () => {
  const source = readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  assert.match(source, /FLOETERM_E2E_GO_RUN\?\.trim\(\) \|\| 'go run -tags floeterm_native'/);
});

test('requires the isolated runner to provide a reserved loopback port and state directory', () => {
  const config = readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/runE2E.mjs', import.meta.url), 'utf8');
  const packageJSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJSON.scripts['test:e2e'], 'node scripts/runE2E.mjs');
  assert.doesNotMatch(config, /\?\? 8282/);
  assert.match(config, /FLOETERM_E2E_PORT is required/);
  assert.match(config, /FLOETERM_E2E_STATE_DIR is required/);
  assert.match(runner, /host: '127\.0\.0\.1', port: 0, exclusive: true/);
  assert.match(runner, /mkdtemp\(join\(tmpdir\(\), 'floeterm-e2e-'\)\)/);
});

test('keeps functional browser tests headless unless explicitly requested', () => {
  const config = readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /const headed = process\.env\.FLOETERM_E2E_HEADED === '1'/);
  assert.doesNotMatch(config, /Boolean\(process\.env\.CI\)/);
});
