import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';

const readSurface = page => page.evaluate(() => {
  const canvas = document.querySelector('.semanticTerminalSurface');
  const harness = window.__floetermPerfHarness;
  const presentation = harness?.getPresentationDiagnostics?.();
  if (!(canvas instanceof HTMLCanvasElement) || !harness || !presentation) {
    throw new Error('semantic DPR diagnostics are unavailable');
  }
  const rect = canvas.getBoundingClientRect();
  return {
    identity: canvas.dataset.dprTestIdentity,
    css: { width: rect.width, height: rect.height },
    backing: { width: canvas.width, height: canvas.height },
    dpr: devicePixelRatio,
    connected: harness.getSnapshot().connection.isConnected,
    geometry: harness.getGeometryDiagnostics(),
    presentation: {
      sequence: presentation.sequence,
      generation: presentation.geometry.generation,
      cols: presentation.geometry.cols,
      rows: presentation.geometry.rows,
      width: presentation.frame.width,
      height: presentation.frame.height,
    },
    errors: document.querySelectorAll('.terminalRendererError').length,
    canvases: document.querySelectorAll('.terminalPane canvas').length,
  };
});

test('updates the existing canvas backing for DPR-only changes at fixed CSS geometry', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected
    && window.__floetermPerfHarness.getPresentationDiagnostics?.());
  await page.locator('.semanticTerminalSurface').evaluate(canvas => { canvas.dataset.dprTestIdentity = 'stable'; });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size is unavailable');
  const cdp = await page.context().newCDPSession(page);
  const initial = await readSurface(page);

  for (const dpr of [1.5, 2, 1]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await expect.poll(async () => {
      const state = await readSurface(page);
      return state.dpr === dpr
        && state.backing.width === Math.round(state.css.width * dpr)
        && state.backing.height === Math.round(state.css.height * dpr);
    }, { message: `semantic canvas did not settle at DPR ${dpr}` }).toBe(true);
    const state = await readSurface(page);
    expect(state.identity).toBe('stable');
    expect(state.connected).toBe(true);
    expect(state.canvases).toBe(1);
    expect(state.errors).toBe(0);
    expect(state.geometry.cols).toBe(state.presentation.cols);
    expect(state.geometry.rows).toBe(state.presentation.rows);
    expect(state.presentation.width).toBe(state.presentation.cols);
    expect(state.presentation.height).toBe(state.presentation.rows);
    expect(state.presentation.sequence).toBeGreaterThanOrEqual(initial.presentation.sequence);
    expect(state.presentation.generation).toBeGreaterThanOrEqual(initial.presentation.generation);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  expect(failures).toEqual([]);
});
