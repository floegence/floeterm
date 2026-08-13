import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const readRendererGeometry = page => page.evaluate(() => {
  const harness = window.__floetermPerfHarness;
  const pane = document.querySelector('.terminalPane');
  const canvas = document.querySelector('.semanticTerminalSurface');
  const presentation = harness?.getPresentationDiagnostics?.();
  if (!harness || !(pane instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement) || !presentation) {
    throw new Error('semantic renderer geometry is unavailable');
  }
  const paneRect = pane.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  return {
    dpr: devicePixelRatio,
    backingWidth: canvas.width,
    backingHeight: canvas.height,
    cssWidth: canvasRect.width,
    cssHeight: canvasRect.height,
    cssTop: canvasRect.top,
    cssLeft: canvasRect.left,
    paneWidth: pane.clientWidth,
    paneHeight: pane.clientHeight,
    paneTop: paneRect.top + pane.clientTop,
    paneLeft: paneRect.left + pane.clientLeft,
    canvases: pane.querySelectorAll('canvas').length,
    legacyCanvases: pane.querySelectorAll('.floeterm-beamterm-canvas').length,
    errors: document.querySelectorAll('.terminalRendererError').length,
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

const isConverged = geometry => geometry.canvases === 1
  && geometry.legacyCanvases === 0
  && geometry.errors === 0
  && Math.abs(geometry.cssWidth - geometry.paneWidth) < 1
  && Math.abs(geometry.cssHeight - geometry.paneHeight) < 1
  && Math.abs(geometry.cssTop - geometry.paneTop) < 1
  && Math.abs(geometry.cssLeft - geometry.paneLeft) < 1
  && geometry.backingWidth === Math.round(geometry.cssWidth * geometry.dpr)
  && geometry.backingHeight === Math.round(geometry.cssHeight * geometry.dpr)
  && geometry.host.cols === geometry.geometry.cols
  && geometry.host.rows === geometry.geometry.rows
  && geometry.presentation.cols === geometry.geometry.cols
  && geometry.presentation.rows === geometry.geometry.rows
  && geometry.presentation.frameWidth === geometry.geometry.cols
  && geometry.presentation.frameHeight === geometry.geometry.rows;

const dominantBackground = image => {
  const colors = new Map();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const key = `${image.data[offset] >> 2}:${image.data[offset + 1] >> 2}:${image.data[offset + 2] >> 2}`;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  return [...colors.entries()].sort((left, right) => right[1] - left[1])[0][0]
    .split(':').map(value => Number(value) * 4 + 2);
};

const cellInkCounts = (imageBuffer, cellWidth, cellHeight, row, cols) => {
  const image = PNG.sync.read(imageBuffer);
  const background = dominantBackground(image);
  return cols.map(col => {
    let ink = 0;
    const startX = Math.max(0, Math.floor(col * cellWidth));
    const endX = Math.min(image.width, Math.ceil((col + 1) * cellWidth));
    const startY = Math.max(0, Math.floor(row * cellHeight));
    const endY = Math.min(image.height, Math.ceil((row + 1) * cellHeight));
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * image.width + x) * 4;
        const distance = Math.abs(image.data[offset] - background[0])
          + Math.abs(image.data[offset + 1] - background[1])
          + Math.abs(image.data[offset + 2] - background[2]);
        if (distance > 18) ink += 1;
      }
    }
    return ink;
  });
};

const edgeInk = (imageBuffer, geometry, row) => {
  const image = PNG.sync.read(imageBuffer);
  const background = dominantBackground(image);
  const cellWidth = image.width / geometry.presentation.cols;
  const cellHeight = image.height / geometry.presentation.rows;
  const startX = Math.max(0, Math.floor((geometry.presentation.cols - 9) * cellWidth));
  const startY = Math.max(0, Math.floor(row * cellHeight));
  const endY = Math.min(image.height, Math.ceil((row + 1) * cellHeight));
  let ink = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const distance = Math.abs(image.data[offset] - background[0])
        + Math.abs(image.data[offset + 1] - background[1])
        + Math.abs(image.data[offset + 2] - background[2]);
      if (distance > 18) ink += 1;
    }
  }
  return ink;
};

const openTerminal = async page => {
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);
};

test('keeps semantic canvas, PTY geometry, and final edge pixels fitted through browser resizing', async ({ page }, testInfo) => {
  const failures = captureBrowserFailures(page);
  await openTerminal(page);

  for (const [width, height] of [[1024, 720], [780, 520], [1380, 860], [900, 600]]) {
    await page.setViewportSize({ width, height });
    await expect.poll(async () => isConverged(await readRendererGeometry(page))).toBe(true);
  }

  const geometry = await readRendererGeometry(page);
  const edgeRow = Math.min(6, geometry.presentation.rows - 1);
  const edgeMarker = 'EDGE1234';
  const edgeCol = geometry.presentation.cols - edgeMarker.length + 1;
  const payloadHex = Buffer.from(
    `\x1b[3J\x1b[2J\x1b[HSEMANTIC_GEOMETRY\x1b[${edgeRow + 1};${edgeCol}H${edgeMarker}`,
  ).toString('hex');
  await page.evaluate(hex => {
    window.__floetermPerfHarness.sendInput(
      `python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`,
    );
  }, payloadHex);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), edgeMarker);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const screenshot = await page.locator('.semanticTerminalSurface').screenshot({ animations: 'disabled' });
  await testInfo.attach('semantic-renderer-geometry.png', { body: screenshot, contentType: 'image/png' });
  expect(edgeInk(screenshot, geometry, edgeRow), JSON.stringify(geometry)).toBeGreaterThan(8);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});

test('keeps both columns of adjacent CJK glyphs visible in the semantic frame', async ({ page }, testInfo) => {
  const failures = captureBrowserFailures(page);
  await openTerminal(page);

  const marker = 'A中文B';
  const payloadHex = Buffer.from(`\x1b[3J\x1b[2J\x1b[H${marker}`).toString('hex');
  await page.evaluate(hex => {
    window.__floetermPerfHarness.sendInput(
      `python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`,
    );
  }, payloadHex);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), marker);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const geometry = await readRendererGeometry(page);
  expect(isConverged(geometry), JSON.stringify(geometry)).toBe(true);
  const screenshot = await page.locator('.semanticTerminalSurface').screenshot({ animations: 'disabled' });
  await testInfo.attach('semantic-renderer-adjacent-cjk.png', { body: screenshot, contentType: 'image/png' });
  const image = PNG.sync.read(screenshot);
  const cellWidth = image.width / geometry.presentation.cols;
  const cellHeight = image.height / geometry.presentation.rows;
  const ink = cellInkCounts(screenshot, cellWidth, cellHeight, 0, [0, 1, 2, 3, 4, 5]);

  expect(await page.evaluate(() => window.__floetermPerfHarness.serialize())).toContain(marker);
  expect(ink[2], JSON.stringify({ ink, geometry })).toBeGreaterThan(2);
  expect(ink[4], JSON.stringify({ ink, geometry })).toBeGreaterThan(2);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});
