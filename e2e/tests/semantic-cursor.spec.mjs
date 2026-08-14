import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const holdTerminalState = bytes => {
  const hex = Buffer.from(bytes, 'utf8').toString('hex');
  return `python3 -c "import os,time;os.write(1,bytes.fromhex('${hex}'));time.sleep(30)"\r`;
};

const readCursor = page => page.evaluate(() => {
  const presentation = window.__floetermPerfHarness?.getPresentationDiagnostics?.();
  if (!presentation) throw new Error('semantic cursor presentation is unavailable');
  return {
    sequence: presentation.sequence,
    geometry: presentation.geometry,
    frame: { width: presentation.frame.width, height: presentation.frame.height, bufferKind: presentation.frame.bufferKind },
    cursor: presentation.frame.cursor,
  };
});

const waitForCursor = async (page, expected) => {
  await expect.poll(async () => {
    const state = await readCursor(page);
    return Object.entries(expected).every(([key, value]) => state.cursor[key] === value);
  }).toBe(true);
  return readCursor(page);
};

const interruptHeldState = async page => {
  await page.evaluate(() => window.__floetermPerfHarness.sendInput('\x03'));
  await page.waitForTimeout(100);
};

const countCursorInk = (buffer, cursor) => {
  const image = PNG.sync.read(buffer);
  const left = Math.max(0, Math.floor(cursor.x * 9));
  const top = Math.max(0, Math.floor(cursor.y * 18));
  const right = Math.min(image.width, left + 9);
  const bottom = Math.min(image.height, top + 18);
  let bright = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] > 180 && image.data[offset + 1] > 180 && image.data[offset + 2] > 180 && image.data[offset + 3] === 255) bright += 1;
    }
  }
  return { bright, area: Math.max(1, (right - left) * (bottom - top)) };
};

test('renders the authoritative Ghostty cursor across modes, graphemes, alternate screen, resize, and views', async ({ page, context }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getTerminalInfo());
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]').getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command), holdTerminalState('\x1b[2J\x1b[H\x1b[?25h\x1b[2 q\x1b[3;6H'));
  const block = await waitForCursor(page, { x: 5, y: 2, visible: true, shape: 'block', blinking: false });
  const blockPixels = countCursorInk(await page.locator('.semanticTerminalSurface').screenshot({ animations: 'disabled' }), block.cursor);
  expect(blockPixels.bright).toBeGreaterThan(blockPixels.area * 0.8);
  await interruptHeldState(page);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command), holdTerminalState('\x1b[5 q\x1b[?25l\x1b[2;4H'));
  await waitForCursor(page, { x: 3, y: 1, visible: false, shape: 'bar', blinking: true });
  await interruptHeldState(page);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command), holdTerminalState('\x1b[?25h\x1b[6 q\x1b[4;7H'));
  await waitForCursor(page, { x: 6, y: 3, visible: true, shape: 'bar', blinking: false });
  await interruptHeldState(page);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command), holdTerminalState('\x1b[4 q\x1b[1;1H界e\u0301'));
  await waitForCursor(page, { x: 3, y: 0, visible: true, shape: 'underline', blinking: false });
  await interruptHeldState(page);

  await page.evaluate(command => window.__floetermPerfHarness.sendInput(command), holdTerminalState('\x1b[?1049h\x1b[3;5H'));
  const alternate = await waitForCursor(page, { x: 4, y: 2, visible: true });
  expect(alternate.frame.bufferKind).toBe('alternate');

  const observer = await context.newPage();
  const observerFailures = captureBrowserFailures(observer);
  await observer.goto(`/?mode=single&session=${encodeURIComponent(sessionId)}&perf_probe=1`);
  await observer.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected && window.__floetermPerfHarness.getPresentationDiagnostics?.());
  await observer.locator('textarea[aria-label="Terminal input"]').focus();
  const observerCursor = await readCursor(observer);
  expect(observerCursor.cursor).toEqual(alternate.cursor);
  expect(observerCursor.frame).toEqual(alternate.frame);

  await page.setViewportSize({ width: 780, height: 520 });
  await expect.poll(async () => {
    const state = await readCursor(page);
    return state.cursor.x >= 0 && state.cursor.x < state.frame.width && state.cursor.y >= 0 && state.cursor.y < state.frame.height
      && state.geometry.cols === state.frame.width && state.geometry.rows === state.frame.height;
  }).toBe(true);

  await interruptHeldState(page);
  await page.evaluate(() => window.__floetermPerfHarness.sendInput("printf '\\033[?1049l'\r"));
  await expect.poll(async () => (await readCursor(page)).frame.bufferKind).toBe('normal');
  await observer.close();
  await expect(page.locator('.terminalRendererError')).toHaveCount(0);
  expect(failures).toEqual([]);
  expect(observerFailures).toEqual([]);
});
