import { expect, test } from '@playwright/test';

import { captureBrowserFailures } from '../support/browserFailures.mjs';

const readGridOwnership = page => page.evaluate(() => {
  const runtime = document.querySelector('[data-testid="demo-runtime-state"]');
  const tiles = [...document.querySelectorAll('.gridTerminalTile:not(.gridTerminalTileShell)')];
  const dpr = devicePixelRatio || 1;
  return {
    busy: runtime?.getAttribute('data-grid-busy'),
    sessions: Number(runtime?.getAttribute('data-grid-session-count') ?? -1),
    connected: Number(runtime?.getAttribute('data-grid-connected') ?? -1),
    errors: Number(runtime?.getAttribute('data-grid-errors') ?? -1),
    rendererErrors: document.querySelectorAll('.terminalRendererError').length,
    tiles: tiles.map(tile => {
      const host = tile.querySelector('.tileTerminal');
      const canvases = [...tile.querySelectorAll('canvas')];
      const visible = canvases.filter(canvas => {
        const style = getComputedStyle(canvas);
        const bounds = canvas.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
      });
      const canvas = visible[0];
      if (!(host instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
        return { ready: false, canvases: canvases.length, visible: visible.length };
      }
      const hostBounds = host.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      return {
        ready: true,
        canvases: canvases.length,
        visible: visible.length,
        semantic: visible.filter(item => item.classList.contains('semanticTerminalSurface')).length,
        legacy: visible.filter(item => !item.classList.contains('semanticTerminalSurface')).length,
        host: { width: host.clientWidth, height: host.clientHeight, left: hostBounds.left + host.clientLeft, top: hostBounds.top + host.clientTop },
        canvas: { width: canvasBounds.width, height: canvasBounds.height, left: canvasBounds.left, top: canvasBounds.top, backingWidth: canvas.width, backingHeight: canvas.height },
        dpr,
      };
    }),
  };
});

const gridConverged = state => state.busy === 'false'
  && state.sessions === 4
  && state.connected === 4
  && state.errors === 0
  && state.rendererErrors === 0
  && state.tiles.length === 4
  && state.tiles.every(tile => tile.ready
    && tile.canvases === 1
    && tile.visible === 1
    && tile.semantic === 1
    && tile.legacy === 0
    && Math.abs(tile.canvas.left - tile.host.left) < 1
    && Math.abs(tile.canvas.top - tile.host.top) < 1
    && Math.abs(tile.canvas.width - tile.host.width) < 1
    && Math.abs(tile.canvas.height - tile.host.height) < 1
    && tile.canvas.backingWidth === Math.round(tile.canvas.width * tile.dpr)
    && tile.canvas.backingHeight === Math.round(tile.canvas.height * tile.dpr));

test('keeps every grid tile on one semantic canvas through repeated browser resizes', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/?mode=grid&count=4&perf_probe=1');
  await expect.poll(async () => gridConverged(await readGridOwnership(page)), { timeout: 30_000 }).toBe(true);

  for (const viewport of [
    { width: 1280, height: 760 },
    { width: 820, height: 620 },
    { width: 1440, height: 900 },
    { width: 760, height: 680 },
    { width: 1180, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => gridConverged(await readGridOwnership(page)), {
      message: `grid renderer ownership did not converge at ${viewport.width}x${viewport.height}`,
    }).toBe(true);
  }

  expect(failures).toEqual([]);
});
