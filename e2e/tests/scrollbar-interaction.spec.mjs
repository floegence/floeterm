import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const openTerminalWithHistory = async page => {
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => (
    window.__floetermPerfHarness?.getSnapshot().connection.isConnected
      && window.__floetermPerfHarness.getTerminalInfo()
  ));
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]')
    .getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);
  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    `python3 -c "for i in range(320): print(f'SCROLLBAR_PHYSICAL_{i:04d}')"\r`,
  ));
  await page.waitForFunction(() => (
    window.__floetermPerfHarness.serialize().includes('SCROLLBAR_PHYSICAL_0319')
  ));
  const scrollbar = page.getByRole('scrollbar', { name: 'Terminal scrollback' });
  await expect(scrollbar).toHaveAttribute('aria-valuemax', /[1-9]\d*/);
  const controlledId = await scrollbar.getAttribute('aria-controls');
  if (!controlledId) throw new Error('terminal scrollbar aria-controls is missing');
  const rendererOwnership = await page.locator('.terminalPane').evaluateAll(panes => panes.map(pane => {
    const visibleCanvases = [...pane.querySelectorAll('canvas')].filter(canvas => {
      const style = getComputedStyle(canvas);
      const bounds = canvas.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    });
    return {
      visibleCanvasCount: visibleCanvases.length,
      semanticCanvasCount: visibleCanvases.filter(canvas => canvas.classList.contains('semanticTerminalSurface')).length,
      legacyCanvasCount: visibleCanvases.filter(canvas => !canvas.classList.contains('semanticTerminalSurface')).length,
    };
  }));
  expect(rendererOwnership).toEqual([{ visibleCanvasCount: 1, semanticCanvasCount: 1, legacyCanvasCount: 0 }]);
  return {
    scrollbar,
    pane: page.locator('.terminalPane'),
    surface: page.locator(`#${controlledId}`),
    canvas: page.locator('.semanticTerminalSurface'),
    terminal: page.locator('#semantic-terminal-input'),
  };
};

test('uses real mouse, wheel, keyboard, focus, selection, and media preferences', async ({ context, page }) => {
  const failures = captureBrowserFailures(page);
  const { scrollbar, pane, surface, canvas, terminal } = await openTerminalWithHistory(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  const surfaceBox = await surface.boundingBox();
  const scrollbarBox = await scrollbar.boundingBox();
  if (!surfaceBox) throw new Error('terminal surface has no bounding box');
  if (!scrollbarBox) throw new Error('terminal scrollbar has no bounding box');
  const rightEdgeX = scrollbarBox.x + scrollbarBox.width / 2;
  const centerY = scrollbarBox.y + scrollbarBox.height / 2;

  await pane.evaluate(element => {
    window.__floetermRailWheelEvents = 0;
    element.addEventListener('wheel', () => { window.__floetermRailWheelEvents += 1; }, true);
  });
  const maximum = Number(await scrollbar.getAttribute('aria-valuemax'));
  await page.mouse.move(rightEdgeX, centerY);
  await expect(scrollbar).toHaveAttribute('data-hovered', 'true');
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => Number(await scrollbar.getAttribute('aria-valuenow'))).toBeLessThan(maximum);
  expect(await page.evaluate(() => window.__floetermRailWheelEvents)).toBe(1);

  await page.mouse.move(rightEdgeX, scrollbarBox.y + 12);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => Number(await scrollbar.getAttribute('aria-valuenow'))).toBeLessThan(maximum / 4);

  await scrollbar.focus();
  await page.keyboard.press('End');
  await expect(scrollbar).toHaveAttribute('aria-valuenow', String(maximum));
  const thumb = page.locator('[data-semantic-history-thumb]');
  const thumbBox = await thumb.boundingBox();
  if (!thumbBox) throw new Error('terminal scrollbar thumb has no bounding box');
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await expect(scrollbar).toHaveAttribute('data-dragging', 'true');
  await page.mouse.move(rightEdgeX, scrollbarBox.y + 1, { steps: 8 });
  await expect(scrollbar).toHaveAttribute('data-dragging', 'true');
  await expect(scrollbar).toHaveAttribute('aria-valuenow', '0');
  await page.mouse.move(scrollbarBox.x - 80, centerY, { steps: 8 });
  await expect(scrollbar).toHaveAttribute('data-dragging', 'true');
  await expect.poll(async () => Number(await scrollbar.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(scrollbar).toHaveAttribute('data-dragging', 'false');
  await expect(scrollbar).toHaveAttribute('data-hovered', 'false');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Terminal input');
  await expect(scrollbar).toHaveAttribute('data-visible', 'false', { timeout: 2_000 });

  await scrollbar.focus();
  await page.keyboard.press('End');
  await expect(scrollbar).toHaveAttribute('aria-valuenow', String(maximum));

  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error('semantic terminal canvas has no bounding box');
  await page.mouse.move(canvasBox.x + 12, canvasBox.y + 24);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 180, canvasBox.y + 24, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.hasSelection())).toBe(true);
  expect((await page.evaluate(() => window.__floetermPerfHarness.getSelectionText())).length).toBeGreaterThan(0);

  await terminal.focus();
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Terminal input');

  await page.mouse.move(rightEdgeX, centerY);
  await expect(scrollbar).toHaveAttribute('data-hovered', 'true');
  await page.mouse.move(surfaceBox.x - 8, surfaceBox.y - 8);
  await expect(scrollbar).toHaveAttribute('data-hovered', 'false');
  await expect(scrollbar).toHaveAttribute('data-visible', 'false', { timeout: 2_000 });

  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  expect(await scrollbar.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
  expect(await thumb.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('1px');
  expect(failures).toEqual([]);
});

test('projects a complete viewport atomically and keeps it stable while live output advances', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  const { scrollbar, pane } = await openTerminalWithHistory(page);
  const maximum = Number(await scrollbar.getAttribute('aria-valuemax'));

  await pane.hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => Number(await scrollbar.getAttribute('aria-valuenow'))).toBeLessThan(maximum);
  const historyOffset = Number(await scrollbar.getAttribute('aria-valuenow'));
  const projected = await page.evaluate(() => ({
    lines: window.__floetermPerfHarness.getVisibleLines(),
    rows: window.__floetermPerfHarness.getTerminalInfo()?.rows ?? 0,
  }));
  expect(projected.lines).toHaveLength(projected.rows);
  expect(projected.rows).toBeGreaterThan(9);

  await page.evaluate(() => window.__floetermPerfHarness.sendInput("printf 'HISTORY_LIVE_ADVANCE\\n'\r"));
  await page.waitForFunction(() => window.__floetermPerfHarness
    ?.getPresentationDiagnostics?.().frame.rows
    .some(row => row.cells.map(cell => cell.text).join('').includes('HISTORY_LIVE_ADVANCE')));

  expect(Number(await scrollbar.getAttribute('aria-valuenow'))).toBe(historyOffset);
  expect((await page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'))))
    .not.toContain('HISTORY_LIVE_ADVANCE');

  await scrollbar.focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.evaluate(() => window.__floetermPerfHarness.serialize()))
    .toContain('HISTORY_LIVE_ADVANCE');
  expect(failures).toEqual([]);
});

test('keeps the right-edge scrollbar transparent to a real touchscreen hit test', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 900, height: 700 },
  });
  const page = await context.newPage();
  try {
    const { scrollbar, canvas } = await openTerminalWithHistory(page);
    const scrollbarBox = await scrollbar.boundingBox();
    if (!scrollbarBox) throw new Error('terminal scrollbar has no bounding box');
    await canvas.evaluate(element => {
      window.__floetermTouchTarget = '';
      element.addEventListener('pointerdown', event => {
        window.__floetermTouchTarget = event.pointerType;
      }, true);
    });
    await page.touchscreen.tap(
      scrollbarBox.x + scrollbarBox.width / 2,
      scrollbarBox.y + scrollbarBox.height / 2,
    );
    await expect.poll(() => page.evaluate(() => window.__floetermTouchTarget)).toBe('touch');
    await expect(scrollbar).toHaveCSS('pointer-events', 'none');
    await expect(scrollbar).toHaveAttribute('data-dragging', 'false');
  } finally {
    await context.close();
  }
});
