import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const kittyCommand = bytes => {
  const hex = Buffer.from(bytes, 'binary').toString('hex');
  return 'python3 -c "import os;os.write(1,bytes.fromhex(\'' + hex + '\'))"\r';
};

test('renders and removes real Kitty graphics through the single semantic canvas', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command),
    kittyCommand('\x1b_Ga=T,f=24,s=1,v=1,i=7,q=2;/wAA\x1b\\'));
  await page.waitForFunction(() => {
    const graphics = window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.frame.graphics;
    return graphics?.images.length === 1
      && graphics.images[0]?.id === 7
      && graphics.images[0]?.pixels?.[0] === 255
      && graphics.placements.some(item => item.imageId === 7 && item.visible);
  });

  const state = await page.evaluate(() => {
    const presentation = window.__floetermPerfHarness.getPresentationDiagnostics();
    const pane = document.querySelector('.terminalPane');
    const canvas = document.querySelector('.semanticTerminalSurface');
    if (!presentation || !(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('semantic graphics diagnostics are unavailable');
    }
    const placement = presentation.frame.graphics.placements.find(item => item.imageId === 7 && item.visible);
    if (!placement) throw new Error('visible Kitty placement is unavailable');
    return {
      frame: { width: presentation.frame.width, height: presentation.frame.height },
      placement,
      canvases: pane.querySelectorAll('canvas').length,
      legacyCanvases: pane.querySelectorAll('canvas:not(.semanticTerminalSurface)').length,
      rendererErrors: pane.querySelectorAll('.terminalRendererError').length,
    };
  });
  expect(state).toMatchObject({ canvases: 1, legacyCanvases: 0, rendererErrors: 0 });

  const canvas = page.locator('.semanticTerminalSurface');
  const image = PNG.sync.read(await canvas.screenshot({ animations: 'disabled' }));
  const cellWidth = image.width / state.frame.width;
  const cellHeight = image.height / state.frame.height;
  const left = Math.max(0, Math.floor(state.placement.viewportColumn * cellWidth));
  const top = Math.max(0, Math.floor(state.placement.viewportRow * cellHeight));
  const right = Math.min(image.width, Math.ceil((state.placement.viewportColumn + state.placement.gridColumns) * cellWidth));
  const bottom = Math.min(image.height, Math.ceil((state.placement.viewportRow + state.placement.gridRows) * cellHeight));
  let redPixels = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] > 220 && image.data[offset + 1] < 40 && image.data[offset + 2] < 40) redPixels += 1;
    }
  }
  expect(redPixels).toBeGreaterThan(Math.max(1, Math.floor((right - left) * (bottom - top) * 0.8)));

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command),
    kittyCommand('\x1b_Ga=d,d=I,i=7,q=2\x1b\\'));
  await page.waitForFunction(() => {
    const graphics = window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.frame.graphics;
    return graphics?.images.length === 0 && graphics.placements.length === 0;
  });
  await expect(page.locator('.terminalRendererError')).toHaveCount(0);
  expect(failures).toEqual([]);
});
