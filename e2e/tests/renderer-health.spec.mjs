import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const readSemanticRenderer = page => page.evaluate(() => {
  const harness = window.__floetermPerfHarness;
  const pane = document.querySelector('.terminalPane');
  const canvas = document.querySelector('.semanticTerminalSurface');
  const presentation = harness?.getPresentationDiagnostics?.();
  if (!harness || !(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement) || !presentation) {
    throw new Error('semantic renderer diagnostics are unavailable');
  }
  const paneRect = pane.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const visibleCanvases = [...pane.querySelectorAll('canvas')].filter(candidate => {
    const style = getComputedStyle(candidate);
    const rect = candidate.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  });
  return {
    connected: harness.getSnapshot().connection.isConnected,
    errors: document.querySelectorAll('.terminalRendererError').length,
    allCanvases: pane.querySelectorAll('canvas').length,
    visibleCanvases: visibleCanvases.length,
    legacyCanvases: pane.querySelectorAll('canvas:not(.semanticTerminalSurface)').length,
    pane: {
      width: pane.clientWidth,
      height: pane.clientHeight,
      top: paneRect.top + pane.clientTop,
      left: paneRect.left + pane.clientLeft,
    },
    canvas: {
      width: canvasRect.width,
      height: canvasRect.height,
      top: canvasRect.top,
      left: canvasRect.left,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
    },
    dpr: devicePixelRatio,
    host: harness.getSnapshot().state.dimensions,
    geometry: harness.getGeometryDiagnostics(),
    presentation: {
      sequence: presentation.sequence,
      cols: presentation.geometry.cols,
      rows: presentation.geometry.rows,
      frameWidth: presentation.frame.width,
      frameHeight: presentation.frame.height,
    },
  };
});

const countInk = imageBuffer => {
  const image = PNG.sync.read(imageBuffer);
  const colors = new Map();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const key = `${image.data[offset] >> 2}:${image.data[offset + 1] >> 2}:${image.data[offset + 2] >> 2}`;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  const background = [...colors.entries()].sort((left, right) => right[1] - left[1])[0][0]
    .split(':').map(value => Number(value) * 4 + 2);
  let ink = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const distance = Math.abs(image.data[offset] - background[0])
      + Math.abs(image.data[offset + 1] - background[1])
      + Math.abs(image.data[offset + 2] - background[2]);
    if (distance > 18) ink += 1;
  }
  return ink;
};

test('keeps the single semantic renderer alive and fitted while output and browser bounds advance', async ({ page }) => {
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

  const marker = 'SEMANTIC_RENDERER_HEALTH_AbgQ9_中文_😀';
  await page.evaluate(value => {
    window.__floetermPerfHarness.sendInput(`printf '\\033[3J\\033[2J\\033[H%s\\n' '${value}'\r`);
  }, marker);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), marker);

  let previousSequence = 0;
  for (const [width, height] of [[920, 640], [1380, 860], [760, 520], [1240, 760]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => {
      const state = await readSemanticRenderer(page);
      const converged = state.connected
        && state.errors === 0
        && state.allCanvases === 1
        && state.visibleCanvases === 1
        && state.legacyCanvases === 0
        && Math.abs(state.canvas.width - state.pane.width) < 1
        && Math.abs(state.canvas.height - state.pane.height) < 1
        && Math.abs(state.canvas.top - state.pane.top) < 1
        && Math.abs(state.canvas.left - state.pane.left) < 1
        && state.canvas.backingWidth === Math.round(state.canvas.width * state.dpr)
        && state.canvas.backingHeight === Math.round(state.canvas.height * state.dpr)
        && state.host.cols === state.geometry.cols
        && state.host.rows === state.geometry.rows
        && state.presentation.cols === state.geometry.cols
        && state.presentation.rows === state.geometry.rows
        && state.presentation.frameWidth === state.geometry.cols
        && state.presentation.frameHeight === state.geometry.rows;
      return converged;
    }).toBe(true);

    await page.evaluate(() => window.__floetermPerfHarness.sendInput("printf 'FRAME_ADVANCE\\n'\r"));
    await expect.poll(async () => {
      const state = await readSemanticRenderer(page);
      if (state.presentation.sequence <= previousSequence) return false;
      previousSequence = state.presentation.sequence;
      return true;
    }).toBe(true);
  }

  const canvas = page.locator('.semanticTerminalSurface');
  await expect(canvas).toBeVisible();
  const screenshot = await canvas.screenshot({ animations: 'disabled' });
  expect(countInk(screenshot)).toBeGreaterThan(100);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});
