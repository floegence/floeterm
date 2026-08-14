import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';
import { waitForInteractiveShell } from '../support/sessionReadiness.mjs';

const dispatchComposition = async (page, updates, commit) => page.locator('textarea[aria-label="Terminal input"]').evaluate(
  (textarea, payload) => {
    const createInputEvent = (inputType, data, isComposing = false) => {
      const event = new Event('beforeinput', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        inputType: { value: inputType },
        data: { value: data },
        isComposing: { value: isComposing },
      });
      return event;
    };
    textarea.focus({ preventScroll: true });
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const update of payload.updates) {
      textarea.value = update;
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: update }));
      textarea.dispatchEvent(createInputEvent('insertCompositionText', update, true));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: update, inputType: 'insertCompositionText', isComposing: true }));
    }
    const candidateEnter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperties(candidateEnter, { keyCode: { value: 229 }, isComposing: { value: true } });
    textarea.dispatchEvent(candidateEnter);
    textarea.value = payload.commit;
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: payload.commit }));
    textarea.dispatchEvent(createInputEvent('insertText', payload.commit, false));
    textarea.value = payload.commit;
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: payload.commit, inputType: 'insertText' }));
  },
  { updates, commit },
);

const cursorAnchor = page => page.evaluate(() => {
  const canvas = document.querySelector('.semanticTerminalSurface');
  const input = document.querySelector('textarea[aria-label="Terminal input"]');
  const presentation = window.__floetermPerfHarness?.getPresentationDiagnostics?.();
  if (!(canvas instanceof HTMLCanvasElement) || !(input instanceof HTMLTextAreaElement) || !presentation) return null;
  const canvasRect = canvas.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const width = Math.min(9, canvasRect.width);
  const height = Math.min(18, canvasRect.height);
  const left = Math.max(canvasRect.left, Math.min(canvasRect.left + presentation.frame.cursor.x * 9, canvasRect.right - width));
  const top = Math.max(canvasRect.top, Math.min(canvasRect.top + presentation.frame.cursor.y * 18, canvasRect.bottom - height));
  return {
    actual: { left: inputRect.left, top: inputRect.top, width: inputRect.width, height: inputRect.height },
    expected: { left, top, width, height },
    dpr: devicePixelRatio,
    cursor: presentation.frame.cursor,
    geometry: presentation.geometry,
    canvases: document.querySelectorAll('.terminalPane canvas').length,
  };
});

const expectAnchor = async page => {
  await expect.poll(async () => {
    const anchor = await cursorAnchor(page);
    if (!anchor) return false;
    return Object.keys(anchor.expected).every(key => Math.abs(anchor.actual[key] - anchor.expected[key]) <= 1);
  }).toBe(true);
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const originalScale = CanvasRenderingContext2D.prototype.scale;
    window.__semanticScaleCalls = [];
    CanvasRenderingContext2D.prototype.scale = function semanticScaleAudit(x, y) {
      window.__semanticScaleCalls.push([x, y]);
      return originalScale.call(this, x, y);
    };
  });
});

test('commits IME text exactly once while preedit, cancellation, and candidate Enter stay local', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected);
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]').getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    `python3 -c "import os,select,termios;old=termios.tcgetattr(0);new=termios.tcgetattr(0);new[3]&=~(termios.ICANON|termios.ECHO);termios.tcsetattr(0,termios.TCSANOW,new);print('CANCEL_READY',flush=True);ready=select.select([0],[],[],1)[0];data=os.read(0,100) if ready else b'';print('CANCEL_BYTES='+(data.hex() or 'NONE'),flush=True);termios.tcsetattr(0,termios.TCSANOW,old)"\r`,
  ));
  await page.waitForFunction(() => window.__floetermPerfHarness.getVisibleLines().join('\n').includes('CANCEL_READY'));
  await dispatchComposition(page, ['qu', 'q'], '');
  await expect.poll(
    async () => (await page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'))),
    { timeout: 15_000 },
  ).toContain('CANCEL_BYTES=NONE');
  await waitForInteractiveShell(page, sessionId);

  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    `python3 -c "import sys;print('IME_READY',flush=True);print(sys.stdin.buffer.readline().hex(),flush=True)"\r`,
  ));
  await page.waitForFunction(() => window.__floetermPerfHarness.getVisibleLines().join('\n').includes('IME_READY'));
  await dispatchComposition(page, ['zh', 'zhong'], '中文');
  await page.locator('textarea[aria-label="Terminal input"]').press('Enter');
  await expect.poll(
    async () => (await page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'))),
    { timeout: 30_000 },
  ).toContain('e4b8ade69687');
  const output = await page.evaluate(() => window.__floetermPerfHarness.getVisibleLines().join('\n'));
  expect(output).not.toContain('e4b8ade69687e4b8ade69687');
  expect(output).not.toContain('zhong');
  expect(failures).toEqual([]);
});

test('anchors IME at the semantic cursor and paints wide graphemes without horizontal scaling', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=single&perf_probe=1');
  await page.waitForFunction(() => window.__floetermPerfHarness?.getSnapshot().connection.isConnected
    && window.__floetermPerfHarness.getPresentationDiagnostics?.());
  const sessionId = await page.locator('[data-testid="demo-runtime-state"]').getAttribute('data-single-session-id');
  if (!sessionId) throw new Error('single terminal session id is unavailable');
  await waitForInteractiveShell(page, sessionId);

  await page.locator('.semanticTerminalSurface').click({ position: { x: 20, y: 20 } });
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', 'Terminal input');
  await expectAnchor(page);
  await page.evaluate(() => window.__floetermPerfHarness.sendInput(
    `python3 -c "import os,time;os.write(1,'\\033[2J\\033[H\\033[4;6HA中B é 👨‍👩‍👧‍👦'.encode());time.sleep(30)"\r`,
  ));
  await page.waitForFunction(() => {
    const frame = window.__floetermPerfHarness?.getPresentationDiagnostics?.()?.frame;
    return frame?.rows.some(row => row.cells.some(cell => cell.text === '中' && cell.width === 2));
  });
  await expectAnchor(page);
  expect(await page.evaluate(() => window.__semanticScaleCalls)).toEqual([]);
  const cjk = await page.evaluate(() => {
    const frame = window.__floetermPerfHarness.getPresentationDiagnostics().frame;
    for (let row = 0; row < frame.rows.length; row += 1) {
      const cells = frame.rows[row].cells;
      const col = cells.findIndex(cell => cell.text === '中');
      if (col >= 0) return { row, col, cells: cells.slice(col - 1, col + 3).map(cell => ({ text: cell.text, width: cell.width })) };
    }
    return null;
  });
  expect(cjk?.cells).toEqual([
    { text: 'A', width: 1 },
    { text: '中', width: 2 },
    { text: '', width: 0 },
    { text: 'B', width: 1 },
  ]);

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport unavailable');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 2, mobile: false,
  });
  await expectAnchor(page);
  await page.setViewportSize({ width: 980, height: 650 });
  await expectAnchor(page);
  expect(await page.evaluate(() => window.__semanticScaleCalls)).toEqual([]);
  expect(failures).toEqual([]);
});

test('keeps a separate anchored input bridge beside the sole canvas in every mirror and grid view', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=mirror&perf_probe=1');
  await expect(page.locator('.mirrorTerminalView .semanticTerminalSurface')).toHaveCount(2);
  await expect(page.locator('.mirrorTerminalView textarea[aria-label="Terminal input"]')).toHaveCount(2);
  await page.waitForFunction(() => window.__floetermMirrorHarness?.getViews().length === 2
    && window.__floetermMirrorHarness.getViews().every(view => view.getPresentationDiagnostics?.()));
  for (const view of await page.locator('.mirrorTerminalView').all()) {
    await expect(view.locator('canvas')).toHaveCount(1);
    await expect(view.locator('textarea[aria-label="Terminal input"]')).toHaveCount(1);
    const inside = await view.evaluate(node => {
      const canvas = node.querySelector('.semanticTerminalSurface');
      const input = node.querySelector('textarea[aria-label="Terminal input"]');
      if (!(canvas instanceof HTMLCanvasElement) || !(input instanceof HTMLTextAreaElement)) return false;
      const surface = canvas.getBoundingClientRect();
      const anchor = input.getBoundingClientRect();
      return anchor.left >= surface.left - 1 && anchor.right <= surface.right + 1
        && anchor.top >= surface.top - 1 && anchor.bottom <= surface.bottom + 1;
    });
    expect(inside).toBe(true);
  }

  await page.goto('/?mode=grid&count=4');
  await expect(page.locator('.gridTerminalTile .semanticTerminalSurface')).toHaveCount(4);
  await expect(page.locator('.gridTerminalTile textarea[aria-label="Terminal input"]')).toHaveCount(4);
  await expect(page.locator('[data-testid="demo-runtime-state"]')).toHaveAttribute('data-grid-connected', '4');
  for (const tile of await page.locator('.gridTerminalTile').all()) {
    await expect(tile.locator('canvas')).toHaveCount(1);
    await expect(tile.locator('textarea[aria-label="Terminal input"]')).toHaveCount(1);
  }
  expect(failures).toEqual([]);
});
