import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';

test('renders dynamic-atlas glyphs through the owned WebGL2 backend without warnings', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));

  const canvas = page.locator('.floeterm-beamterm-canvas');
  await expect(canvas).toBeVisible();
  const before = await page.evaluate(() => window.__floetermPerfHarness.getFabricDiagnostics());
  const marker = 'OWNED_RENDERER_DYNAMIC_ATLAS_AbgQ9_中文_😀';
  await page.evaluate(value => {
    window.__floetermPerfHarness.sendInput(`printf '\\033[3J\\033[2J\\033[H%s\\n' '${value}'\r`);
  }, marker);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), marker);
  await page.waitForFunction(previousFrameCount => (
    window.__floetermPerfHarness.getFabricDiagnostics().renderedFrameCount > previousFrameCount
  ), before.renderedFrameCount);
  const after = await page.evaluate(() => window.__floetermPerfHarness.getFabricDiagnostics());

  expect(after).toMatchObject({
    backend: 'beamterm_webgl2',
    renderPath: 'main_thread_webgl2',
    webgl2Supported: true,
    beamtermLoaded: true,
    lastError: '',
  });
  expect(after.renderedFrameCount).toBeGreaterThan(before.renderedFrameCount);
  expect(after.lastFrameDirtyCells).toBeGreaterThan(0);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});
