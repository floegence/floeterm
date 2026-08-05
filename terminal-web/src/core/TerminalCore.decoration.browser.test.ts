import { afterEach, describe, expect, it } from 'vitest';

import { TerminalCore } from './TerminalCore.js';

type BeamtermSize = { width: number; height: number; free(): void };
type BeamtermHandle = { cellSize(): BeamtermSize; render(): void };

const cores: TerminalCore[] = [];
const originalDpr = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

const write = (core: TerminalCore, data: string): Promise<void> => new Promise(resolve => {
  core.writeHistory(data, resolve);
});

const readBeamtermHandle = (core: TerminalCore): BeamtermHandle => {
  const renderer = (core as unknown as {
    fabricView?: { renderer?: { renderer?: BeamtermHandle } };
  }).fabricView?.renderer?.renderer;
  if (!renderer) throw new Error('Beamterm renderer handle is unavailable');
  return renderer;
};

const snapshotCanvas = (source: HTMLCanvasElement): ImageData => {
  const gl = source.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 readback is unavailable');
  gl.finish();
  const pixels = new Uint8Array(source.width * source.height * 4);
  gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const topDown = new Uint8ClampedArray(pixels.length);
  const rowBytes = source.width * 4;
  for (let y = 0; y < source.height; y += 1) {
    const sourceStart = (source.height - y - 1) * rowBytes;
    topDown.set(pixels.subarray(sourceStart, sourceStart + rowBytes), y * rowBytes);
  }
  return new ImageData(topDown, source.width, source.height);
};

const rowInkCount = (
  image: ImageData,
  y: number,
  xStart: number,
  xEnd: number,
): number => {
  let count = 0;
  for (let x = xStart; x < xEnd; x += 1) {
    const offset = (y * image.width + x) * 4;
    if (image.data[offset] + image.data[offset + 1] + image.data[offset + 2] > 90) count += 1;
  }
  return count;
};

afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  document.body.replaceChildren();
  if (originalDpr) Object.defineProperty(window, 'devicePixelRatio', originalDpr);
});

describe('TerminalCore WebGL line decorations', () => {
  for (const fontSize of [10, 12, 20]) {
    for (const dpr of [1, 2]) {
      it(`keeps a ${fontSize}px underline adjacent to text at DPR ${dpr}`, async () => {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
        const host = document.createElement('div');
        Object.assign(host.style, {
          position: 'fixed',
          inset: '0 auto auto 0',
          width: '640px',
          height: '240px',
          background: '#000000',
        });
        document.body.appendChild(host);

        const core = new TerminalCore(host, {
          rendererType: 'webgl',
          fixedDimensions: { cols: 20, rows: 4 },
          fontFamily: 'monospace',
          fontSize,
          theme: { background: '#000000', foreground: '#ffffff' },
          cursorBlink: false,
        });
        cores.push(core);
        await core.initialize();
        await write(core, '\x1b[2J\x1b[1;1HMMMM\x1b[2;1H\x1b[4mMMMM\x1b[24m');
        await core.forceResizeAndWaitForPresentation();

        const canvas = host.querySelector<HTMLCanvasElement>('.floeterm-beamterm-canvas');
        expect(canvas).not.toBeNull();
        if (!canvas) return;
        const renderer = readBeamtermHandle(core);
        const size = renderer.cellSize();
        const cellWidth = Number(size.width);
        const cellHeight = Number(size.height);
        size.free();
        renderer.render();
        const image = snapshotCanvas(canvas);
        const xEnd = Math.min(image.width, cellWidth * 4);
        const plainRows = Array.from(
          { length: cellHeight },
          (_, y) => rowInkCount(image, y, 0, xEnd),
        );
        const underlineRows = Array.from(
          { length: cellHeight },
          (_, y) => rowInkCount(image, cellHeight + y, 0, xEnd),
        );
        const denseUnderlineRows = underlineRows
          .map((count, y) => ({ count: Math.max(0, count - plainRows[y]), y }))
          .filter(({ count }) => count >= xEnd * 0.5);
        const plainInkBottom = plainRows.reduce(
          (bottom, count, y) => (count > 0 ? y : bottom),
          -1,
        );

        expect(plainInkBottom).toBeGreaterThanOrEqual(0);
        expect(denseUnderlineRows.length).toBeGreaterThan(0);
        const underlineCenter = denseUnderlineRows.reduce(
          (sum, row) => sum + row.y * row.count,
          0,
        ) / denseUnderlineRows.reduce((sum, row) => sum + row.count, 0);
        expect((underlineCenter - plainInkBottom) / dpr).toBeGreaterThanOrEqual(0);
        expect((underlineCenter - plainInkBottom) / dpr).toBeLessThanOrEqual(2);
        expect(denseUnderlineRows.at(-1)!.y).toBeLessThan(cellHeight - dpr);

        const nextRowInk = Array.from(
          { length: cellHeight },
          (_, y) => rowInkCount(image, cellHeight * 2 + y, 0, xEnd),
        ).reduce((sum, count) => sum + count, 0);
        expect(nextRowInk).toBe(0);
      });
    }
  }
});
