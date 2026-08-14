import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { captureBrowserFailures } from '../support/browserFailures.mjs';

const visiblePixelSample = buffer => {
  const image = PNG.sync.read(buffer);
  const points = [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1], [Math.floor(image.width / 2), Math.floor(image.height / 2)]];
  const pixels = points.map(([x, y]) => {
    const offset = (Math.max(0, y) * image.width + Math.max(0, x)) * 4;
    return [...image.data.subarray(offset, offset + 4)];
  });
  return {
    pixels,
    ok: pixels.every(pixel => pixel[3] === 255)
      && !pixels.every(pixel => pixel[0] > 245 && pixel[1] > 245 && pixel[2] > 245),
  };
};

test('keeps the semantic live session and surface geometry through repeated window resizes', async ({ page, request }) => {
  const response = await request.post('/api/sessions', { data: { name: `resize-stress-${Date.now()}`, workingDir: '' } });
  expect(response.ok()).toBe(true);
  const session = await response.json();
  const failures = captureBrowserFailures(page);
  await page.goto(`/?mode=single&session=${encodeURIComponent(session.id)}&perf_probe=1`);
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
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
    const desired = harness.getSnapshot().state.dimensions;
    const presentation = harness.getPresentationDiagnostics();
    const trace = harness.getResizeDiagnostics();
    const summary = trace.find(item => item?.action === 'summary');
    const settled = [...trace].reverse().find(item => item?.action === 'resize-applied' || item?.action === 'attach-applied');
    const lifecycleClose = [...trace].reverse().find(item => item?.action === 'lifecycle-closed');
    return {
      connected: harness.getSnapshot().connection.isConnected,
      canvases: document.querySelectorAll('.terminalPane canvas').length,
      visibleCanvases: [...document.querySelectorAll('.terminalPane canvas')].filter(node => {
        const rect = node.getBoundingClientRect();
        const nodeStyle = getComputedStyle(node);
        return nodeStyle.display !== 'none' && nodeStyle.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).length,
      errors: document.querySelectorAll('.terminalRendererError').length,
      pane: { width: pane.clientWidth, height: pane.clientHeight, left: paneRect.left + pane.clientLeft, top: paneRect.top + pane.clientTop },
      canvas: { width: canvasRect.width, height: canvasRect.height, left: canvasRect.left, top: canvasRect.top, backingWidth: canvas.width, backingHeight: canvas.height },
      dpr,
      style: { width: style.width, height: style.height },
      geometry,
      desired,
      settled: settled?.geometry ?? null,
      presentation: presentation ? {
        sequence: presentation.sequence,
        generation: presentation.geometry.generation,
        cols: presentation.geometry.cols,
        rows: presentation.geometry.rows,
        frameWidth: presentation.frame.width,
        frameHeight: presentation.frame.height,
      } : null,
      lifecycleClose: lifecycleClose ?? null,
      attachRequestCount: summary?.attachRequestCount ?? -1,
      lifecycleCloseCount: summary?.lifecycleCloseCount ?? -1,
      resizeRequests: trace.filter(item => item?.action === 'resize-requested').length,
      resizeApplied: trace.filter(item => item?.action === 'resize-applied').length,
    };
  });
  let previous = await readState();
  for (let i = 0; i < 60; i += 1) {
    const viewport = { width: 800 + (i % 5) * 137, height: 500 + (i % 4) * 113 };
    await page.setViewportSize(viewport);
    const visibleFrames = await page.evaluate(() => new Promise(resolve => {
      const samples = [];
      const sample = () => requestAnimationFrame(() => setTimeout(() => {
        const pane = document.querySelector('.terminalPane');
        const canvas = document.querySelector('.semanticTerminalSurface');
        const presentation = window.__floetermPerfHarness?.getPresentationDiagnostics?.();
        if (!(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement) || !presentation) {
          samples.push({ ok: false, reason: 'surface unavailable' });
        } else {
          const rect = canvas.getBoundingClientRect();
          const dpr = devicePixelRatio || 1;
          samples.push({
            ok: Math.abs(rect.width - pane.clientWidth) < 1
              && Math.abs(rect.height - pane.clientHeight) < 1
              && canvas.width === Math.round(rect.width * dpr)
              && canvas.height === Math.round(rect.height * dpr),
            pane: { width: pane.clientWidth, height: pane.clientHeight },
            canvas: { width: rect.width, height: rect.height, backingWidth: canvas.width, backingHeight: canvas.height },
            sequence: presentation.sequence,
            generation: presentation.geometry.generation,
          });
        }
        if (samples.length === 3) resolve(samples);
        else sample();
      }, 0));
      sample();
    }));
    expect(visibleFrames.every(sample => sample.ok), `resize ${i + 1} exposed an uncommitted canvas geometry: ${JSON.stringify(visibleFrames)}`).toBe(true);
    expect(visibleFrames.every((sample, index) => index === 0 || (sample.sequence >= visibleFrames[index - 1].sequence && sample.generation >= visibleFrames[index - 1].generation)), `resize ${i + 1} regressed a visible Presentation: ${JSON.stringify(visibleFrames)}`).toBe(true);
    const pixels = visiblePixelSample(await page.locator('.semanticTerminalSurface').screenshot({ animations: 'disabled' }));
    expect(pixels.ok, `resize ${i + 1} exposed a transparent/white canvas: ${JSON.stringify(pixels)}`).toBe(true);
    const immediateSurface = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
      const pane = document.querySelector('.terminalPane');
      const canvas = document.querySelector('.semanticTerminalSurface');
      const dpr = window.devicePixelRatio || 1;
      if (!(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
        resolve({ ok: false, reason: 'surface unavailable' });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      resolve({
        ok: Math.abs(rect.width - pane.clientWidth) < 1
          && Math.abs(rect.height - pane.clientHeight) < 1,
        pane: { width: pane.clientWidth, height: pane.clientHeight },
        canvas: { width: rect.width, height: rect.height, backingWidth: canvas.width, backingHeight: canvas.height },
        dpr,
      });
    })));
    expect(immediateSurface.ok, `semantic surface/backing did not follow resize ${i + 1}: ${JSON.stringify(immediateSurface)}`).toBe(true);

    let current;
    await expect.poll(async () => {
      current = await readState();
      return current.connected
        && current.canvases === 1
        && current.visibleCanvases === 1
        && current.errors === 0
        && Math.abs(current.canvas.left - current.pane.left) < 1
        && Math.abs(current.canvas.top - current.pane.top) < 1
        && Math.abs(current.canvas.width - current.pane.width) < 1
        && Math.abs(current.canvas.height - current.pane.height) < 1
        && current.canvas.backingWidth === Math.round(current.canvas.width * current.dpr)
        && current.canvas.backingHeight === Math.round(current.canvas.height * current.dpr)
        && current.settled?.cols === current.desired.cols
        && current.settled?.rows === current.desired.rows
        && current.geometry.cols === current.desired.cols
        && current.geometry.rows === current.desired.rows
        && current.presentation?.cols === current.desired.cols
        && current.presentation?.rows === current.desired.rows
        && current.presentation?.frameWidth === current.desired.cols
        && current.presentation?.frameHeight === current.desired.rows;
    }, { message: `resize ${i + 1} did not converge at ${viewport.width}x${viewport.height}` }).toBe(true);
    expect(current.attachRequestCount, `resize ${i + 1} unexpectedly reattached`).toBe(1);
    expect(current.lifecycleCloseCount, `resize ${i + 1} closed the live attachment: ${JSON.stringify(current.lifecycleClose)}`).toBe(0);
    expect(current.presentation.sequence, `presentation sequence regressed at resize ${i + 1}`).toBeGreaterThanOrEqual(previous.presentation.sequence);
    expect(current.presentation.generation, `presentation generation regressed at resize ${i + 1}`).toBeGreaterThanOrEqual(previous.presentation.generation);
    expect(current.geometry.generation, `canonical generation regressed at resize ${i + 1}`).toBeGreaterThanOrEqual(previous.geometry.generation);
    previous = current;
  }
  const lastState = await readState();
  expect(lastState.resizeApplied).toBeGreaterThan(0);
  expect(lastState.resizeRequests).toBeGreaterThanOrEqual(lastState.resizeApplied);
  expect(failures).toEqual([]);
});
