import { afterEach, describe, expect, it } from 'vitest';
import { Ghostty, type GhosttyCell, type GhosttyTerminal } from 'ghostty-web';

import { TerminalCore } from './TerminalCore.js';

type CoreTerminal = {
  wasmTerm: GhosttyTerminal;
};

type FabricRenderer = {
  startFrame: (frame: unknown, options: { cols: number; rows: number }) => void;
  writeRow: (
    sourceRenderer: { currentBuffer?: { getGraphemeString?: (row: number, col: number) => string } | null },
    row: number,
    cells: readonly GhosttyCell[],
    cols: number,
    hints?: unknown,
  ) => void;
  finishFrame: (cursor: { x: number; y: number; visible: boolean } | null) => unknown;
  getGeometry: () => { cols: number; rows: number; cellWidth: number; cellHeight: number } | null;
};

type ProjectionCell = {
  codepoint: number;
  width: number;
  flags: number;
  fg: [number, number, number];
  bg: [number, number, number];
  hyperlinkId: number;
  grapheme: string;
};

type TerminalState = {
  cols: number;
  rows: number;
  alternate: boolean;
  cursor: { x: number; y: number; visible: boolean };
  modes: Record<string, boolean>;
  cells: ProjectionCell[][];
};

const cores: TerminalCore[] = [];

const writeFrame = (core: TerminalCore, data: string): Promise<void> => (
  new Promise(resolve => core.writeFrame(data, resolve))
);

const cellSnapshot = (
  cell: GhosttyCell | undefined,
  grapheme: string | undefined,
): ProjectionCell => ({
  codepoint: Number(cell?.codepoint ?? 0),
  width: Number(cell?.width ?? 1),
  flags: Number(cell?.flags ?? 0),
  fg: [Number(cell?.fg_r ?? 255), Number(cell?.fg_g ?? 255), Number(cell?.fg_b ?? 255)],
  bg: [Number(cell?.bg_r ?? 0), Number(cell?.bg_g ?? 0), Number(cell?.bg_b ?? 0)],
  hyperlinkId: Number(cell?.hyperlink_id ?? 0),
  grapheme: Number(cell?.grapheme_len ?? 0) > 0 ? (grapheme ?? '') : '',
});

const snapshotGhostty = (terminal: GhosttyTerminal): TerminalState => {
  const dimensions = terminal.getDimensions();
  const cells = Array.from({ length: dimensions.rows }, (_, row) => {
    const line = terminal.getLine(row) ?? [];
    return Array.from({ length: dimensions.cols }, (_, col) => cellSnapshot(
      line[col],
      terminal.getGraphemeString(row, col),
    ));
  });
  const cursor = terminal.getCursor();
  const modes = Object.fromEntries([25, 47, 1047, 1049, 2004].map(mode => [
    String(mode), terminal.getMode(mode),
  ]));
  return {
    cols: dimensions.cols,
    rows: dimensions.rows,
    alternate: terminal.isAlternateScreen(),
    cursor: { x: cursor.x, y: cursor.y, visible: Boolean(cursor.visible) },
    modes,
    cells,
  };
};

const instrumentProjection = (core: TerminalCore) => {
  const internal = core as unknown as {
    terminal: CoreTerminal;
    fabricView: { renderer: FabricRenderer };
  };
  const renderer = internal.fabricView.renderer;
  const projection = new Map<number, ProjectionCell[]>();
  let dimensions = { cols: 0, rows: 0 };
  let cursor: { x: number; y: number; visible: boolean } | null = null;
  const startFrame = renderer.startFrame.bind(renderer);
  const writeRowOriginal = renderer.writeRow.bind(renderer);
  const finishFrame = renderer.finishFrame.bind(renderer);

  renderer.startFrame = (frame, options) => {
    dimensions = { cols: options.cols, rows: options.rows };
    for (const row of projection.keys()) {
      if (row >= options.rows) projection.delete(row);
    }
    if ((frame as { forceAll?: boolean }).forceAll) projection.clear();
    startFrame(frame, options);
  };
  renderer.writeRow = (sourceRenderer, row, cells, cols, hints) => {
    projection.set(row, Array.from({ length: cols }, (_, col) => cellSnapshot(
      cells[col],
      sourceRenderer.currentBuffer?.getGraphemeString?.(row, col),
    )));
    writeRowOriginal(sourceRenderer, row, cells, cols, hints);
  };
  renderer.finishFrame = nextCursor => {
    cursor = nextCursor ? { ...nextCursor, visible: Boolean(nextCursor.visible) } : null;
    return finishFrame(nextCursor);
  };

  return {
    state(): TerminalState {
      const parserState = snapshotGhostty(internal.terminal.wasmTerm);
      return {
        ...parserState,
        cursor: cursor ?? parserState.cursor,
        cells: Array.from({ length: dimensions.rows }, (_, row) => (
          projection.get(row) ?? Array.from({ length: dimensions.cols }, () => cellSnapshot(undefined, ''))
        )),
      };
    },
    geometry: () => renderer.getGeometry(),
  };
};

const createCore = async (cols: number, rows: number): Promise<TerminalCore> => {
  const host = document.createElement('div');
  Object.assign(host.style, {
    width: `${Math.max(640, cols * 9)}px`,
    height: `${Math.max(320, rows * 18)}px`,
    background: '#000000',
  });
  document.body.appendChild(host);
  const core = new TerminalCore(host, {
    rendererType: 'webgl',
    sessionId: `long-run-${cols}-${rows}`,
    fixedDimensions: { cols, rows },
    fontFamily: 'monospace',
    fontSize: 12,
    cursorBlink: false,
    theme: { background: '#000000', foreground: '#ffffff' },
  });
  cores.push(core);
  await core.initialize();
  core.setConnected(true);
  await core.forceResizeAndWaitForCommittedFrame();
  const renderer = (core as unknown as { fabricView: { renderer: FabricRenderer } }).fabricView.renderer;
  const geometry = renderer.getGeometry();
  if (geometry) {
    host.style.width = `${Math.ceil(geometry.cellWidth * cols)}px`;
    host.style.height = `${Math.ceil(geometry.cellHeight * rows)}px`;
    await core.forceResizeAndWaitForCommittedFrame();
  }
  return core;
};

const topLikeUpdate = (index: number, rows: number, cols: number): string => {
  const row = 2 + (index % Math.max(1, rows - 3));
  const color = 31 + (index % 7);
  const long = index % 3 !== 1;
  const text = long
    ? `PID ${String((index * 17) % 99999).padStart(5, '0')}  worker-${index % 97}  中文 cafe\u0301 😀`
    : `P${index % 1000} idle`;
  const bounded = Array.from(text).slice(0, Math.max(1, cols - 2)).join('');
  return `\x1b[${row};1H\x1b[2K\x1b[${color}m${bounded}\x1b[0m\x1b[?25${index % 2 === 0 ? 'l' : 'h'}`;
};

const topLikeFrame = (index: number, rows: number, cols: number): string => {
  if (index === 0) {
    return `\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[1;1H\x1b[1mTOP-LIKE LIVE\x1b[0m\r\n`
      + Array.from({ length: rows - 2 }, (_, row) => `row-${row + 2}`).join('\r\n')
      + topLikeUpdate(index, rows, cols);
  }
  return topLikeUpdate(index, rows, cols);
};

const boundedHexWindow = (data: string): string => (
  Array.from(new TextEncoder().encode(data).slice(-64), byte => byte.toString(16).padStart(2, '0')).join(' ')
);

const compareStates = (
  actual: TerminalState,
  expected: TerminalState,
  checkpoint: number,
  byteWindow: string,
): void => {
  expect({
    checkpoint,
    actual: { cols: actual.cols, rows: actual.rows, alternate: actual.alternate, cursor: actual.cursor, modes: actual.modes },
    expected: { cols: expected.cols, rows: expected.rows, alternate: expected.alternate, cursor: expected.cursor, modes: expected.modes },
  }).toEqual({
    checkpoint,
    actual: { cols: expected.cols, rows: expected.rows, alternate: expected.alternate, cursor: expected.cursor, modes: expected.modes },
    expected: { cols: expected.cols, rows: expected.rows, alternate: expected.alternate, cursor: expected.cursor, modes: expected.modes },
  });
  for (let row = 0; row < expected.rows; row += 1) {
    for (let col = 0; col < expected.cols; col += 1) {
      if (JSON.stringify(actual.cells[row]?.[col]) !== JSON.stringify(expected.cells[row]?.[col])) {
        throw new Error(JSON.stringify({
          checkpoint,
          firstCellDiff: { row, col },
          actual: actual.cells[row]?.[col],
          expected: expected.cells[row]?.[col],
          byteWindow,
        }));
      }
    }
  }
};

const snapshotCanvas = (canvas: HTMLCanvasElement): ImageData => {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 readback is unavailable');
  gl.finish();
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const topDown = new Uint8ClampedArray(pixels.length);
  const rowBytes = canvas.width * 4;
  for (let row = 0; row < canvas.height; row += 1) {
    const source = (canvas.height - row - 1) * rowBytes;
    topDown.set(pixels.subarray(source, source + rowBytes), row * rowBytes);
  }
  return new ImageData(topDown, canvas.width, canvas.height);
};

const countInk = (image: ImageData, xStart: number, xEnd: number, yStart: number, yEnd: number): number => {
  let count = 0;
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset] + image.data[offset + 1] + image.data[offset + 2] > 90) count += 1;
    }
  }
  return count;
};

afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  document.body.replaceChildren();
});

describe('TerminalCore long-running top-like rendering', () => {
  it('keeps live-only demand rendering equivalent through 50,000 updates (same-Ghostty projection oracle)', async () => {
    // The reference terminal intentionally uses the same pinned Ghostty parser.
    // This proves projection/dirty cleanup/canvas parity, not independent VT semantics.
    const cols = 100;
    const rows = 30;
    const core = await createCore(cols, rows);
    const projection = instrumentProjection(core);
    const ghostty = await Ghostty.load();
    const reference = ghostty.createTerminal(cols, rows, {
      scrollbackLimit: 256,
      fgColor: 0xffffff,
      bgColor: 0x000000,
    });

    const updateCount = 50_000;
    const batchSize = 1_000;
    for (let batchStart = 0; batchStart < updateCount; batchStart += batchSize) {
      let data = '';
      for (let index = batchStart; index < batchStart + batchSize; index += 1) {
        data += topLikeFrame(index, rows, cols);
      }
      reference.write(data);
      await writeFrame(core, data);
      if ((batchStart + batchSize) % 10_000 === 0) {
        compareStates(
          projection.state(),
          snapshotGhostty(reference),
          batchStart + batchSize,
          boundedHexWindow(data),
        );
      }
    }

    const cleanupRow = rows - 2;
    const cleanup = `\x1b[${cleanupRow};1H\x1b[2K\x1b[31mshort\x1b[0m\x1b[1;1H\x1b[?25h`;
    reference.write(cleanup);
    await writeFrame(core, cleanup);
    compareStates(projection.state(), snapshotGhostty(reference), updateCount, boundedHexWindow(cleanup));

    const canvas = document.querySelector<HTMLCanvasElement>('.floeterm-beamterm-canvas');
    expect(canvas).not.toBeNull();
    if (!canvas) return;
    const geometry = projection.geometry();
    expect(geometry).not.toBeNull();
    if (!geometry) return;
    const image = snapshotCanvas(canvas);
    expect(countInk(
      image,
      Math.floor(image.width * 0.45),
      image.width,
      Math.floor((cleanupRow - 1) * image.height / geometry.rows),
      Math.floor(cleanupRow * image.height / geometry.rows),
    )).toBe(0);
    expect(countInk(image, 0, image.width, 0, image.height)).toBeGreaterThan(0);

    reference.free();
  });

  it('keeps TerminalCore geometry projection ordered (transport boundary is covered in live contracts)', async () => {
    const geometries = [
      { cols: 100, rows: 30 },
      { cols: 140, rows: 52 },
      { cols: 88, rows: 24 },
      { cols: 132, rows: 46 },
    ];
    const first = geometries[0];
    const core = await createCore(first.cols, first.rows);
    const projection = instrumentProjection(core);
    const ghostty = await Ghostty.load();
    const reference = ghostty.createTerminal(first.cols, first.rows, {
      scrollbackLimit: 256,
      fgColor: 0xffffff,
      bgColor: 0x000000,
    });
    const timeline: Array<{ phase: string; cols: number; rows: number }> = [];

    for (let boundary = 0; boundary < geometries.length; boundary += 1) {
      const geometry = geometries[boundary];
      if (boundary > 0) {
        core.setFixedDimensions(geometry);
        const hostGeometry = projection.geometry();
        const host = (core as unknown as { container: HTMLElement }).container;
        if (hostGeometry) {
          host.style.width = `${Math.ceil(hostGeometry.cellWidth * geometry.cols)}px`;
          host.style.height = `${Math.ceil(hostGeometry.cellHeight * geometry.rows)}px`;
        }
        reference.resize(geometry.cols, geometry.rows);
        await core.forceResizeAndWaitForCommittedFrame();
      }
      timeline.push({ phase: `boundary-${boundary}-committed`, ...core.getDimensions() });
      expect(core.getDimensions()).toEqual(geometry);
      expect(projection.state()).toEqual(expect.objectContaining(geometry));

      const data = `\x1b[${Math.min(geometry.rows, 6)};1H\x1b[2K\x1b[1mgeometry-${geometry.cols}x${geometry.rows}\x1b[0m`;
      reference.write(data);
      await writeFrame(core, data);
      timeline.push({ phase: `boundary-${boundary}-output`, ...core.getDimensions() });
      compareStates(projection.state(), snapshotGhostty(reference), boundary, boundedHexWindow(data));
    }

    expect(timeline).toEqual([
      { phase: 'boundary-0-committed', cols: 100, rows: 30 },
      { phase: 'boundary-0-output', cols: 100, rows: 30 },
      { phase: 'boundary-1-committed', cols: 140, rows: 52 },
      { phase: 'boundary-1-output', cols: 140, rows: 52 },
      { phase: 'boundary-2-committed', cols: 88, rows: 24 },
      { phase: 'boundary-2-output', cols: 88, rows: 24 },
      { phase: 'boundary-3-committed', cols: 132, rows: 46 },
      { phase: 'boundary-3-output', cols: 132, rows: 46 },
    ]);

    reference.free();
  });
});
