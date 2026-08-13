import { expect, test } from '@playwright/test';
import { captureBrowserFailures } from '../support/browserFailures.mjs';

test('keeps the semantic live session and surface geometry through repeated window resizes', async ({ page, request }) => {
  const response = await request.post('/api/sessions', { data: { name: `resize-stress-${Date.now()}`, workingDir: '' } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  const failures = captureBrowserFailures(page);
  await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
  for (let i = 0; i < 60; i += 1) {
    await page.setViewportSize({ width: 800 + (i % 5) * 137, height: 500 + (i % 4) * 113 });
    const surfaceFits = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const pane = document.querySelector('.terminalPane');
      const canvas = document.querySelector('.semanticTerminalSurface');
      resolve(pane instanceof HTMLElement && canvas instanceof HTMLCanvasElement
        && Math.abs(canvas.getBoundingClientRect().width - pane.clientWidth) < 1
        && Math.abs(canvas.getBoundingClientRect().height - pane.clientHeight) < 1);
    })));
    expect(surfaceFits, `semantic surface did not follow resize ${i + 1}`).toBe(true);
  }
  let lastState;
  const readState = () => page.evaluate(() => {
    const pane = document.querySelector('.terminalPane');
    const canvas = document.querySelector('.semanticTerminalSurface');
    const harness = window.__floetermPerfHarness;
    if (!(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement) || !harness) return { ok: false, reason: 'diagnostics unavailable' };
    const paneRect = pane.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const dpr = window.devicePixelRatio || 1;
    const geometry = harness.getGeometryDiagnostics();
    const view = harness.getSnapshot().state.dimensions;
    const info = harness.getTerminalInfo();
    return {
      connected: harness.getSnapshot().connection.isConnected,
      canvases: document.querySelectorAll('.terminalPane canvas').length,
      errors: document.querySelectorAll('.terminalRendererError').length,
      pane: { width: pane.clientWidth, height: pane.clientHeight, left: paneRect.left, top: paneRect.top },
      canvas: { width: canvasRect.width, height: canvasRect.height, left: canvasRect.left, top: canvasRect.top, backingWidth: canvas.width, backingHeight: canvas.height },
      dpr,
      style: { width: style.width, height: style.height },
      geometry,
      view,
      info,
      ok: harness.getSnapshot().connection.isConnected
      && document.querySelectorAll('.terminalPane canvas').length === 1
      && document.querySelectorAll('.terminalRendererError').length === 0
      && Math.abs(canvasRect.left - (paneRect.left + pane.clientLeft)) < 1
      && Math.abs(canvasRect.top - (paneRect.top + pane.clientTop)) < 1
      && Math.abs(canvasRect.width - pane.clientWidth) < 1
      && Math.abs(canvasRect.height - pane.clientHeight) < 1
      && Math.abs(Number.parseFloat(style.width) - pane.clientWidth) < 1
      && Math.abs(Number.parseFloat(style.height) - pane.clientHeight) < 1
      && Math.abs(canvas.width / canvasRect.width - dpr) < 0.01
      && Math.abs(canvas.height / canvasRect.height - dpr) < 0.01
      && geometry.cols === view.cols
      && geometry.rows === view.rows
      && info?.cols === view.cols
      && info?.rows === view.rows,
    };
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    lastState = await readState();
    if (lastState.ok) break;
    await page.waitForTimeout(100);
  }
  if (!lastState?.ok) throw new Error(`resize geometry did not converge: ${JSON.stringify(lastState)}`);
  expect(failures).toEqual([]);
});
