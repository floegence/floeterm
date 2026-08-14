import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const holdTerminalState = bytes => {
  const hex = Buffer.from(bytes, 'utf8').toString('hex');
  return `python3 -c "import os,time;os.write(1,bytes.fromhex('${hex}'));time.sleep(30)"\r`;
};

const kittyCommand = bytes => {
  const hex = Buffer.from(bytes, 'binary').toString('hex');
  return `python3 -c "import os;os.write(1,bytes.fromhex('${hex}'))"\r`;
};

const readPixel = (image, x, y) => {
  const offset = (Math.max(0, Math.min(image.height - 1, y)) * image.width
    + Math.max(0, Math.min(image.width - 1, x))) * 4;
  return [...image.data.subarray(offset, offset + 4)];
};

const expectColor = (actual, expected) => {
  expect(actual).toHaveLength(4);
  for (let index = 0; index < 4; index += 1) {
    expect(Math.abs(actual[index] - expected[index])).toBeLessThanOrEqual(index === 3 ? 0 : 1);
  }
};

const captureBacking = async locator => {
  const capture = await locator.evaluate(canvas => ({
    png: canvas.toDataURL('image/png'),
    dpr: devicePixelRatio || 1,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  }));
  const image = PNG.sync.read(Buffer.from(capture.png.slice(capture.png.indexOf(',') + 1), 'base64'));
  return { capture, image };
};

const captureColors = async page => {
  const { capture, image } = await captureBacking(page.locator('.semanticTerminalSurface').first());
  return {
    background: readPixel(image, Math.floor((capture.width - 1) * capture.dpr), Math.floor((capture.height - 1) * capture.dpr)),
    explicitRgb: readPixel(image, Math.floor(4 * capture.dpr), Math.floor(9 * capture.dpr)),
    cursor: readPixel(image, Math.floor(9 * capture.dpr), Math.floor(18 * capture.dpr)),
  };
};

const waitForPaint = page => page.evaluate(() => new Promise(resolve => (
  requestAnimationFrame(() => requestAnimationFrame(resolve))
)));

const chooseTheme = async (page, theme) => {
  await page.getByLabel('Terminal theme').selectOption(theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const background = theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(11, 15, 20)';
  await expect(page.locator('.semanticTerminalSurface').first()).toHaveCSS('background-color', background);
  await waitForPaint(page);
};

test('repaints the latest semantic Presentation with a view-local theme palette', async ({ page, context }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]').getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command), holdTerminalState(
    '\x1b[2J\x1b[H\x1b[48;2;17;34;51m \x1b[0mD\x1b[2;2H\x1b[?25h\x1b[6 q',
  ));
  await page.waitForFunction(() => {
    const frame = window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.frame;
    return frame?.rows[0]?.cells[0]?.style?.background === 'rgb:112233'
      && frame.cursor.x === 1 && frame.cursor.y === 1
      && frame.cursor.shape === 'bar' && frame.cursor.visible;
  });
  const before = await page.evaluate(() => {
    const presentation = window.__floetermPerfHarness.getPresentationDiagnostics();
    return { sequence: presentation.sequence, geometry: presentation.geometry, frame: { width: presentation.frame.width, height: presentation.frame.height } };
  });

  await chooseTheme(page, 'light');
  const light = await captureColors(page);
  expectColor(light.background, [255, 255, 255, 255]);
  expect(light.explicitRgb).toEqual([17, 34, 51, 255]);
  expectColor(light.cursor, [51, 51, 51, 255]);
  await chooseTheme(page, 'dark');
  const dark = await captureColors(page);
  expectColor(dark.background, [11, 15, 20, 255]);
  expect(dark.explicitRgb).toEqual([17, 34, 51, 255]);
  expectColor(dark.cursor, [201, 209, 217, 255]);
  await chooseTheme(page, 'light');
  expectColor((await captureColors(page)).background, [255, 255, 255, 255]);
  const after = await page.evaluate(() => {
    const presentation = window.__floetermPerfHarness.getPresentationDiagnostics();
    return { sequence: presentation.sequence, geometry: presentation.geometry, frame: { width: presentation.frame.width, height: presentation.frame.height } };
  });
  expect(after).toEqual(before);

  await Promise.all([
    page.setViewportSize({ width: 930, height: 620 }),
    chooseTheme(page, 'dark'),
  ]);
  await expect.poll(async () => page.evaluate(() => {
    const harness = window.__floetermPerfHarness;
    const presentation = harness?.getPresentationDiagnostics?.();
    const geometry = harness?.getGeometryDiagnostics?.();
    const desired = harness?.getSnapshot().state.dimensions;
    const canvas = document.querySelector('.semanticTerminalSurface');
    if (!presentation || !geometry || !desired || !(canvas instanceof HTMLCanvasElement)) return false;
    const rect = canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    return geometry.cols === desired.cols && geometry.rows === desired.rows
      && presentation.geometry.cols === geometry.cols && presentation.geometry.rows === geometry.rows
      && presentation.frame.width === geometry.cols && presentation.frame.height === geometry.rows
      && canvas.width === Math.round(rect.width * dpr) && canvas.height === Math.round(rect.height * dpr);
  })).toBe(true);
  expectColor((await captureColors(page)).background, [11, 15, 20, 255]);
  const resized = await page.evaluate(() => {
    const presentation = window.__floetermPerfHarness.getPresentationDiagnostics();
    return { sequence: presentation.sequence, geometry: presentation.geometry, frame: { width: presentation.frame.width, height: presentation.frame.height } };
  });
  await chooseTheme(page, 'light');
  expect(await page.evaluate(() => {
    const presentation = window.__floetermPerfHarness.getPresentationDiagnostics();
    return { sequence: presentation.sequence, geometry: presentation.geometry, frame: { width: presentation.frame.width, height: presentation.frame.height } };
  })).toEqual(resized);
  expectColor((await captureColors(page)).background, [255, 255, 255, 255]);

  const observer = await context.newPage();
  const observerFailures = captureBrowserFailures(observer);
  await observer.goto(`/?mode=single&session=${encodeURIComponent(sessionId)}&perf_probe=1`);
  await observer.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
  await chooseTheme(observer, 'dark');
  expectColor((await captureColors(observer)).background, [11, 15, 20, 255]);
  expectColor((await captureColors(page)).background, [255, 255, 255, 255]);

  await observer.close();
  await expect(page.locator('.terminalRendererError')).toHaveCount(0);
  expect(failures).toEqual([]);
  expect(observerFailures).toEqual([]);
});

test('applies the selected palette to every semantic canvas in mirror and grid modes', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=mirror&perf_probe=1');
  await expect(page.locator('.mirrorTerminalView .semanticTerminalSurface')).toHaveCount(2);
  await page.waitForFunction(() => window.__floetermMirrorHarness?.getViews().length === 2
    && window.__floetermMirrorHarness.getViews().every(view => view.getPresentationDiagnostics?.()));
  await chooseTheme(page, 'light');
  for (const canvas of await page.locator('.mirrorTerminalView .semanticTerminalSurface').all()) {
    const { capture, image } = await captureBacking(canvas);
    expectColor(readPixel(image, Math.floor((capture.width - 1) * capture.dpr), Math.floor((capture.height - 1) * capture.dpr)), [255, 255, 255, 255]);
  }

  await page.goto('/?mode=grid&count=4');
  await expect(page.locator('.gridTerminalTile .semanticTerminalSurface')).toHaveCount(4);
  await expect(page.locator('[data-testid="demo-runtime-state"]')).toHaveAttribute('data-grid-connected', '4');
  await chooseTheme(page, 'dark');
  for (const canvas of await page.locator('.gridTerminalTile .semanticTerminalSurface').all()) {
    const { capture, image } = await captureBacking(canvas);
    expectColor(readPixel(image, Math.floor((capture.width - 1) * capture.dpr), Math.floor((capture.height - 1) * capture.dpr)), [11, 15, 20, 255]);
  }
  await expect(page.locator('.terminalRendererError')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('keeps semantic graphics intact while repainting theme-owned colors', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected
    && window.__floetermPerfHarness.getPresentationDiagnostics?.());
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]').getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);
  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command),
    kittyCommand('\x1b_Ga=T,f=24,s=1,v=1,i=17,q=2;/wAA\x1b\\'));
  await page.waitForFunction(() => {
    const graphics = window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.frame.graphics;
    return graphics?.images.some(image => image.id === 17)
      && graphics.placements.some(placement => placement.imageId === 17 && placement.visible);
  });
  const before = await page.evaluate(() => {
    const presentation = window.__floetermPerfHarness.getPresentationDiagnostics();
    return {
      sequence: presentation.sequence,
      placement: presentation.frame.graphics.placements.find(item => item.imageId === 17 && item.visible),
    };
  });
  if (!before.placement) throw new Error('semantic graphic placement is unavailable');

  for (const [theme, background] of [['light', [255, 255, 255, 255]], ['dark', [11, 15, 20, 255]]]) {
    await chooseTheme(page, theme);
    const { capture, image } = await captureBacking(page.locator('.semanticTerminalSurface'));
    expectColor(readPixel(
      image,
      Math.floor((before.placement.viewportColumn + 0.5) * 9 * capture.dpr),
      Math.floor((before.placement.viewportRow + 0.5) * 18 * capture.dpr),
    ), [255, 0, 0, 255]);
    expectColor(readPixel(
      image,
      Math.floor((capture.width - 1) * capture.dpr),
      Math.floor((capture.height - 1) * capture.dpr),
    ), background);
    expect((await page.evaluate(() => window.__floetermPerfHarness.getPresentationDiagnostics().sequence)))
      .toBe(before.sequence);
  }

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command),
    kittyCommand('\x1b_Ga=d,d=I,i=17,q=2\x1b\\'));
  await expect(page.locator('.terminalRendererError')).toHaveCount(0);
  expect(failures).toEqual([]);
});
