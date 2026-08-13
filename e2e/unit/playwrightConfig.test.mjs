import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('starts the product E2E backend with the native semantic engine', () => {
  const source = readFileSync(new URL('../playwright.config.mjs', import.meta.url), 'utf8');
  assert.match(source, /FLOETERM_E2E_GO_RUN\?\.trim\(\) \|\| 'go run -tags floeterm_native'/);
});
