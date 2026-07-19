import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

const captureBrowserFailures = page => {
  const failures = [];
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      failures.push(`console:${message.type()}:${message.text()}`);
    }
  });
  page.on('pageerror', error => failures.push(`pageerror:${error.message}`));
  return failures;
};

const inkRowRuns = imageBuffer => {
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

  const runs = [];
  for (const y of occupied) {
    const previous = runs.at(-1);
    if (!previous || y > previous.end + 1) runs.push({ start: y, end: y });
    else previous.end = y;
  }
  return { width: image.width, height: image.height, runs };
};

const readRendererGeometry = page => page.evaluate(() => {
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
    cols: info.cols,
    rows: info.rows,
    expectedCellWidth,
    expectedCellHeight,
    expectedCols: Math.floor(target.width / expectedCellWidth),
    expectedRows: Math.floor(target.height / expectedCellHeight),
  };
});

const expectTypographicGeometry = geometry => {
  expect(geometry.dpr).toBe(1);
  expect(geometry.backingWidth).toBe(Math.round(geometry.cssWidth));
  expect(geometry.backingHeight).toBe(Math.round(geometry.cssHeight));
  expect(geometry.cols).toBe(geometry.expectedCols);
  expect(geometry.rows).toBe(geometry.expectedRows);
};

const expectSeparatedRows = (pixels, minimumRuns) => {
  expect(pixels.runs.length, JSON.stringify(pixels)).toBeGreaterThanOrEqual(minimumRuns);
  for (const [previous, next] of pixels.runs.slice(0, minimumRuns).slice(1).map((run, index) => [
    pixels.runs[index],
    run,
  ])) {
    expect(next.start - previous.end - 1).toBeGreaterThanOrEqual(2);
  }
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
  expectSeparatedRows(inkRowRuns(screenshot), marker.length);

  await page.setViewportSize({ width: 1024, height: 720 });
  await page.evaluate(() => window.__floetermPerfHarness.forceResize());
  await expect.poll(() => readRendererGeometry(page)).not.toMatchObject({
    backingWidth: geometry.backingWidth,
    backingHeight: geometry.backingHeight,
  });
  const resizedGeometry = await readRendererGeometry(page);
  expectTypographicGeometry(resizedGeometry);
  const resizedScreenshot = await canvas.screenshot({ animations: 'disabled' });
  await testInfo.attach('renderer-geometry-resized.png', { body: resizedScreenshot, contentType: 'image/png' });
  expectSeparatedRows(inkRowRuns(resizedScreenshot), marker.length);
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
