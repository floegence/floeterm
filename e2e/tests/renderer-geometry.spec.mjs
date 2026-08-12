import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const TERMINAL_SCROLLBAR_RESERVE_PX = 15;

const inkRows = imageBuffer => {
  const image = PNG.sync.read(imageBuffer);
  const colorCounts = new Map();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const key = `${image.data[offset] >> 2}:${image.data[offset + 1] >> 2}:${image.data[offset + 2] >> 2}`;
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
  }
  const backgroundKey = [...colorCounts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  const background = backgroundKey.split(':').map(value => Number(value) * 4 + 2);
  const occupied = [];
  const scanWidth = Math.min(image.width, 240);
  for (let y = 0; y < image.height; y += 1) {
    let inkPixels = 0;
    for (let x = 0; x < scanWidth; x += 1) {
      const offset = (y * image.width + x) * 4;
      const distance = Math.abs(image.data[offset] - background[0])
        + Math.abs(image.data[offset + 1] - background[1])
        + Math.abs(image.data[offset + 2] - background[2]);
      if (distance > 18) inkPixels += 1;
    }
    if (inkPixels >= 3) occupied.push(y);
  }

  return { width: image.width, height: image.height, occupied };
};

const readRendererGeometry = page => page.evaluate(scrollbarReservePx => {
  const target = document.querySelector('.floeterm-beamterm-canvas');
  const info = window.__floetermPerfHarness.getTerminalInfo();
  if (!(target instanceof HTMLCanvasElement) || !info) throw new Error('renderer geometry is unavailable');
  const fontSize = 12;
  const fontFamily = '"JetBrains Mono", "Berkeley Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Cascadia Code", Consolas, "Roboto Mono", monospace';
  const metricsCanvas = new OffscreenCanvas(128, 128);
  const context = metricsCanvas.getContext('2d');
  if (!context) throw new Error('font metrics context is unavailable');
  context.font = `${fontSize}px ${fontFamily}`;
  const metrics = context.measureText('M');
  const expectedCellWidth = Math.max(1, Math.round(metrics.width));
  const expectedCellHeight = Math.max(1, Math.round(
    metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
  ));
  return {
    dpr: devicePixelRatio,
    backingWidth: target.width,
    backingHeight: target.height,
    cssWidth: target.getBoundingClientRect().width,
    cssHeight: target.getBoundingClientRect().height,
    cssTop: target.getBoundingClientRect().top,
    cssLeft: target.getBoundingClientRect().left,
    surfaceTop: document.querySelector('.terminalSurface')?.getBoundingClientRect().top ?? 0,
    surfaceLeft: document.querySelector('.terminalSurface')?.getBoundingClientRect().left ?? 0,
    logicalWidth: document.querySelector('.terminalSurface')?.clientWidth ?? 0,
    logicalHeight: document.querySelector('.terminalSurface')?.clientHeight ?? 0,
    cols: info.cols,
    rows: info.rows,
    expectedCellWidth,
    expectedCellHeight,
    scrollbarReservePx,
    expectedCols: Math.floor(
      (document.querySelector('.terminalSurface')?.clientWidth - scrollbarReservePx) / expectedCellWidth,
    ),
    expectedRows: Math.floor((document.querySelector('.terminalSurface')?.clientHeight ?? 0) / expectedCellHeight),
  };
}, TERMINAL_SCROLLBAR_RESERVE_PX);

const expectTypographicGeometry = geometry => {
  expect(geometry.dpr).toBe(1);
  expect(geometry.backingWidth).toBeGreaterThanOrEqual(Math.round(geometry.cssWidth));
  expect(geometry.backingHeight).toBeGreaterThanOrEqual(Math.round(geometry.cssHeight));
  expect(geometry.cols).toBe(geometry.expectedCols);
  expect(geometry.rows).toBe(geometry.expectedRows);
  const gridRight = geometry.cols * geometry.expectedCellWidth;
  const logicalRight = geometry.logicalWidth - geometry.scrollbarReservePx;
  expect(gridRight).toBeLessThanOrEqual(logicalRight);
  expect(gridRight + geometry.expectedCellWidth).toBeGreaterThan(
    logicalRight,
  );
};

const expectSeparatedRows = (pixels, minimumRows, cellHeight) => {
  const rows = new Map();
  for (const y of pixels.occupied) {
    const row = Math.floor(y / cellHeight);
    const values = rows.get(row) ?? [];
    values.push(y);
    rows.set(row, values);
  }
  const lineInk = [...rows.entries()].sort(([left], [right]) => left - right)
    .map(([row, occupied]) => ({ row, start: occupied[0], end: occupied.at(-1) }));
  expect(lineInk.length, JSON.stringify({ pixels, cellHeight })).toBeGreaterThanOrEqual(minimumRows);
};

const cellInkCounts = (imageBuffer, cellWidth, cellHeight, row, cols) => {
  const image = PNG.sync.read(imageBuffer);
  const colorCounts = new Map();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const key = `${image.data[offset] >> 2}:${image.data[offset + 1] >> 2}:${image.data[offset + 2] >> 2}`;
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
  }
  const backgroundKey = [...colorCounts.entries()].sort((left, right) => right[1] - left[1])[0][0];
  const background = backgroundKey.split(':').map(value => Number(value) * 4 + 2);
  return cols.map(col => {
    let ink = 0;
    const startX = col * cellWidth;
    const endX = Math.min(image.width, startX + cellWidth);
    const startY = row * cellHeight;
    const endY = Math.min(image.height, startY + cellHeight);
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

test('uses typographic cell advance and line-box metrics without glyph overlap', async ({ page }, testInfo) => {
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

  const marker = [
    'MMMMMMMMMMMMMMMMMMMM',
    'WWWWWWWWWWWWWWWWWWWW',
    'iiiiiiiiiiiiiiiiiiii',
    '0123456789ABCDEFGHIJ',
    '中文宽字符-😀-END',
  ];
  const payloadHex = Buffer.from(`\x1b[3J\x1b[2J\x1b[H${marker.join('\n')}\n`).toString('hex');
  await page.evaluate(hex => {
    window.__floetermPerfHarness.sendInput(
      `python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`,
    );
  }, payloadHex);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), marker.at(-1));

  const canvas = page.locator('.floeterm-beamterm-canvas');
  await expect(canvas).toBeVisible();
  const geometry = await readRendererGeometry(page);
  expectTypographicGeometry(geometry);

  const screenshot = await canvas.screenshot({ animations: 'disabled' });
  await testInfo.attach('renderer-geometry.png', { body: screenshot, contentType: 'image/png' });
  expectSeparatedRows(inkRows(screenshot), marker.length, geometry.expectedCellHeight);

  await page.setViewportSize({ width: 1024, height: 720 });
  await page.evaluate(() => window.__floetermPerfHarness.forceResize());
  await expect.poll(() => readRendererGeometry(page)).toMatchObject({
    logicalWidth: 998,
    logicalHeight: 592,
  });
  const resizedGeometry = await readRendererGeometry(page);
  expectTypographicGeometry(resizedGeometry);
  const resizedScreenshot = await canvas.screenshot({ animations: 'disabled' });
  await testInfo.attach('renderer-geometry-resized.png', { body: resizedScreenshot, contentType: 'image/png' });
  const resizedPixels = inkRows(resizedScreenshot);
  expectSeparatedRows(resizedPixels, marker.length, resizedGeometry.expectedCellHeight);
  expect(resizedGeometry.cssLeft).toBe(resizedGeometry.surfaceLeft);
  expect(resizedGeometry.cssWidth).toBeGreaterThanOrEqual(resizedGeometry.logicalWidth);
  expect(resizedGeometry.cssHeight).toBeGreaterThanOrEqual(resizedGeometry.logicalHeight);
  expect(resizedGeometry.cssTop - resizedGeometry.surfaceTop).toBeCloseTo(
    -(resizedGeometry.backingHeight / resizedGeometry.dpr - resizedGeometry.logicalHeight),
    5,
  );
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});

test('keeps the right halves of adjacent CJK glyphs visible in mixed-width text', async ({ page }, testInfo) => {
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

  const marker = 'A中文B';
  const payloadHex = Buffer.from(`\x1b[3J\x1b[2J\x1b[H${marker}\n`).toString('hex');
  await page.evaluate(hex => {
    window.__floetermPerfHarness.sendInput(
      `python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`,
    );
  }, payloadHex);
  await page.waitForFunction(value => window.__floetermPerfHarness.serialize().includes(value), marker);

  const canvas = page.locator('.floeterm-beamterm-canvas');
  await expect(canvas).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = await readRendererGeometry(page);
  const screenshot = await canvas.screenshot({ animations: 'disabled' });
  await testInfo.attach('renderer-adjacent-cjk.png', { body: screenshot, contentType: 'image/png' });
  const ink = cellInkCounts(screenshot, geometry.expectedCellWidth, geometry.expectedCellHeight, 0, [0, 1, 2, 3, 4, 5]);

  expect(await page.evaluate(() => window.__floetermPerfHarness.serialize())).toContain(marker);
  expect(ink[2], JSON.stringify({ ink, geometry })).toBeGreaterThan(2);
  expect(ink[4], JSON.stringify({ ink, geometry })).toBeGreaterThan(2);
  expect(await page.locator('.terminalRendererError').count()).toBe(0);
  expect(failures).toEqual([]);
});
