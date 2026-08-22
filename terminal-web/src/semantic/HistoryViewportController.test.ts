import { describe, expect, it, vi } from 'vitest';
import { HistoryViewportController } from './HistoryViewportController';
import type {
  SemanticFrame,
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation';
import { SemanticHistoryError } from './presentation';

const COLS = 103;
const ROWS = 37;
const WINDOW_ROWS = ROWS * 10;
const FAST_WINDOW_ROWS = ROWS * 20;

function biasedWindowStart(target: number, windowRows: number, direction: -1 | 0 | 1): number {
  const bufferRows = windowRows - ROWS;
  const before = direction < 0
    ? Math.round(bufferRows * 0.7)
    : direction > 0
      ? Math.round(bufferRows * 0.3)
      : Math.round(bufferRows / 2);
  return target - before;
}

function frame(offset: number, revision = 1, totalRows = 100): SemanticFrame {
  return {
    width: COLS,
    height: ROWS,
    bufferKind: 'normal',
    cursor: { x: 0, y: 0, visible: false, shape: 'block', blinking: false },
    history: { revision, totalRows, screenStartOffset: totalRows - ROWS },
    graphics: { generation: 0, images: [], placements: [] },
    rows: Array.from({ length: ROWS }, (_, row) => ({
      cells: Array.from({ length: COLS }, (_, column) => ({
        text: column === 0 ? `row-${offset + row}` : '',
        width: 1,
      })),
    })),
  };
}

function presentation(sequence = 1, totalRows = 100): SemanticPresentation {
  return {
    sequence,
    geometry: { generation: 1, cols: COLS, rows: ROWS },
    state: { sequence, contentEpoch: 0 },
    frame: frame(totalRows - ROWS, sequence, totalRows),
  };
}

function presentationWithHistoryIdentity(
  sequence: number,
  totalRows: number,
  historyEpoch: number,
  firstRowOrdinal: number,
): SemanticPresentation {
  const value = presentation(sequence, totalRows);
  return {
    ...value,
    frame: {
      ...value.frame,
      history: {
        ...value.frame.history,
        historyEpoch,
        firstRowOrdinal,
        screenStartRowOrdinal: firstRowOrdinal + totalRows - ROWS,
      },
    },
  };
}

function viewport(offset: number, revision = 1, totalRows = 100, anchor = 'frontier'): SemanticHistoryViewport {
  const screenStartOffset = totalRows - ROWS;
  return {
    snapshotId: `snapshot-${offset}-${revision}`,
    lane: 'viewport',
    revision,
    transportGeneration: 7,
    contentEpoch: 0,
    geometryGeneration: 1,
    cols: COLS,
    rows: ROWS,
    anchor,
    firstAvailable: 'first',
    lastAvailable: 'last',
    screenStart: 'screen',
    offset,
    totalRows,
    screenStartOffset,
    hasPrevious: offset > 0,
    hasNext: offset < screenStartOffset,
    frame: frame(offset, revision, totalRows),
  };
}

function windowViewport(offset: number, windowRows: number, revision = 1, totalRows = 300): SemanticHistoryViewport {
  const base = viewport(offset, revision, totalRows);
  return {
    ...base,
    window: true,
    rows: windowRows,
    screenStartOffset: totalRows - windowRows,
    hasPrevious: offset > 0,
    hasNext: offset < totalRows - windowRows,
    frame: {
      ...base.frame,
      height: windowRows,
      rows: Array.from({ length: windowRows }, (_, row) => ({
        cells: Array.from({ length: COLS }, (_, column) => ({
          text: column === 0 ? `row-${offset + row}` : '',
          width: 1,
        })),
      })),
      history: { revision, totalRows, screenStartOffset: totalRows - windowRows },
    },
  };
}

function windowWithHistoryIdentity(
  offset: number,
  windowRows: number,
  revision: number,
  totalRows: number,
  historyEpoch: number,
  firstRowOrdinal: number,
): SemanticHistoryViewport {
  const value = windowViewport(offset, windowRows, revision, totalRows);
  return {
    ...value,
    historyEpoch,
    firstRowOrdinal,
    screenStartRowOrdinal: firstRowOrdinal + totalRows - windowRows,
    frame: {
      ...value.frame,
      rows: Array.from({ length: windowRows }, (_, row) => ({
        cells: Array.from({ length: COLS }, (_, column) => ({
          text: column === 0 ? `ordinal-${firstRowOrdinal + offset + row}` : '',
          width: 1,
        })),
      })),
      history: {
        ...value.frame.history,
        historyEpoch,
        firstRowOrdinal,
        screenStartRowOrdinal: firstRowOrdinal + totalRows - windowRows,
      },
    },
  };
}

function windowForRequest(
  request: SemanticHistoryRequest,
  totalRows: number,
  revision = 1,
): SemanticHistoryViewport {
  const windowRows = request.windowRows ?? request.viewportRows;
  const maximum = totalRows - windowRows;
  const requested = request.targetOffset
    ?? (request.direction === 'end' ? maximum : 0);
  return windowViewport(Math.max(0, Math.min(maximum, requested)), windowRows, revision, totalRows);
}

async function settle(controller: HistoryViewportController): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Promise.resolve();
    if (!controller.getState().busy) return;
  }
  throw new Error('history controller did not settle');
}

describe('HistoryViewportController', () => {
  it('projects a geometry-stable skeleton in the same turn as a cold scroll', async () => {
    let resolveRequest!: (value: SemanticHistoryViewport) => void;
    const request = vi.fn(() => new Promise<SemanticHistoryViewport>(resolve => {
      resolveRequest = resolve;
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, 1_000));

    controller.showOffset(700);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ browsing: true, busy: true, offset: 700 });
    expect(renderer.project).toHaveBeenLastCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({
        cells: expect.arrayContaining([expect.objectContaining({ text: '' })]),
      })]),
      history: expect.objectContaining({ pending: true }),
    }));

    resolveRequest(viewport(700, 1, 1_000));
    await settle(controller);
    expect(controller.getViewport()).toMatchObject({ offset: 700, snapshotId: 'snapshot-700-1' });
    expect(renderer.project).toHaveBeenLastCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({ cells: expect.arrayContaining([{ text: 'row-700', width: 1 }]) })]),
    }));
    controller.dispose();
  });

  it('slices a remote history window locally while the target remains inside it', async () => {
    const totalRows = 1_000;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));

    controller.scrollByRows(-9);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ viewportRows: WINDOW_ROWS, windowRows: WINDOW_ROWS });
    expect(controller.getState().offset).toBe(954);
    expect(renderer.project).toHaveBeenLastCalledWith(expect.objectContaining({
      height: ROWS,
      rows: expect.arrayContaining([expect.objectContaining({ cells: expect.arrayContaining([{ text: 'row-954', width: 1 }]) })]),
    }));

    controller.scrollByRows(-9);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState().offset).toBe(945);
    controller.dispose();
  });

  it('keeps a bounded history window warm across a workbench visibility switch', async () => {
    const totalRows = 1_000;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));

    controller.scrollByRows(-20);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);

    controller.scrollByRows(20);
    expect(controller.getState()).toMatchObject({ browsing: false, offset: totalRows - ROWS });
    expect(controller.getCacheMetrics().extraBytes).toBeGreaterThan(0);

    controller.setVisible(false);
    controller.setVisible(true);
    controller.scrollByRows(-20);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ browsing: true, offset: totalRows - ROWS - 20, error: null });
    expect(controller.getCacheMetrics().extraBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    controller.dispose();
  });

  it('reuses a retained hidden window while the content epoch is stable', async () => {
    const totalRows = 1_000;
    let revision = 1;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows, revision));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(revision, totalRows));

    controller.scrollByRows(-20);
    await settle(controller);
    controller.scrollByRows(20);
    expect(request).toHaveBeenCalledTimes(1);

    controller.setVisible(false);
    revision = 2;
    controller.apply(presentation(revision, totalRows));
    controller.setVisible(true);
    controller.scrollByRows(-20);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getViewport()).toMatchObject({ revision: 1, offset: totalRows - ROWS - 20 });
    expect(controller.getState().error).toBeNull();
    controller.dispose();
  });

  it('rebases the next scroll when bounded live output evicts rows behind a visible snapshot', async () => {
    let totalRows = 1_000;
    let revision = 1;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows, revision));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(revision, totalRows));

    controller.scrollByRows(-20);
    await settle(controller);
    expect(controller.getState().offset).toBe(943);

    totalRows = 800;
    revision = 2;
    controller.apply(presentation(revision, totalRows));
    expect(controller.getState()).toMatchObject({ browsing: true, offset: 943 });

    controller.scrollByRows(-20);
    await settle(controller);

    expect(controller.getState()).toMatchObject({ browsing: true, offset: 723, error: null });
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.getViewport()).toMatchObject({ revision: 2, totalRows: 800, offset: 723 });
    controller.dispose();
  });

  it('retains a window when its first displayed slice starts at the same offset', async () => {
    const totalRows = 1_000;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));

    controller.showOffset(0);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    controller.scrollByRows(9);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState().offset).toBe(9);
    controller.dispose();
  });

  it('separates a 9-row scroll delta from the complete 103x37 viewport and preserves it across live output', async () => {
    let serverOffset: number | null = null;
    const requests: SemanticHistoryRequest[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      requests.push(value);
      if (value.direction === 'end') serverOffset = 63;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      else if (value.direction === 'backward') serverOffset = Math.max(0, (serverOffset ?? 0) - (value.scrollDeltaRows ?? 0));
      else if (value.direction === 'forward') serverOffset = Math.min(63, (serverOffset ?? 0) + (value.scrollDeltaRows ?? 0));
      else serverOffset = 0;
      return viewport(serverOffset);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());

    controller.scrollByRows(-9);
    await settle(controller);

    expect(requests[0]).toEqual({
      lane: 'viewport', direction: 'end', targetOffset: 0, viewportRows: 100, windowRows: 100,
    });
    expect(requests[1]).toEqual({
      lane: 'viewport', direction: 'backward', anchor: 'frontier', snapshotId: 'snapshot-63-1',
      offset: 63, targetOffset: 54, viewportRows: 37,
    });
    const projected = renderer.project.mock.calls.find(call => call[0]?.rows?.[0]?.cells?.[0]?.text === 'row-54')?.[0] as SemanticFrame;
    expect(projected.height).toBe(37);
    expect(projected.rows).toHaveLength(37);
    expect(projected.rows.map(row => row.cells[0]!.text)).toEqual(
      Array.from({ length: 37 }, (_, index) => `row-${54 + index}`),
    );

    controller.apply(presentation(2, 101));
    expect(controller.getState()).toMatchObject({
      browsing: true, offset: 54, totalRows: 101, screenStartOffset: 64,
    });
    expect(renderer.project).not.toHaveBeenCalledWith(null);
    controller.dispose();
  });

  it('reuses a retained history window in both directions without remote prefetch', async () => {
    const totalRows = 300;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(240);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);

    controller.showOffset(200);
    await settle(controller);
    controller.showOffset(240);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState().offset).toBe(240);
    controller.dispose();
  });

  it('keeps the last complete viewport and releases busy when a cache miss fails', async () => {
    let fail = false;
    let anchor = 'frontier';
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (fail) throw new Error('RPC transport error');
      if (value.direction === 'end') serverOffset = 63;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      else if (value.direction === 'backward') serverOffset -= value.scrollDeltaRows ?? 0;
      return viewport(serverOffset, 1, 100, anchor);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.scrollByRows(-9);
    await settle(controller);
    const visible = renderer.project.mock.calls[renderer.project.mock.calls.length - 1]?.[0];
    fail = true;

    controller.showOffset(8);
    await settle(controller);

    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, error: expect.any(Error) });
    expect(renderer.project.mock.calls[renderer.project.mock.calls.length - 1]?.[0]).not.toBe(visible);
    expect(renderer.project.mock.calls[renderer.project.mock.calls.length - 1]?.[0]).toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({
        cells: expect.arrayContaining([expect.objectContaining({ text: '', width: 1 })]),
      })]),
      history: expect.objectContaining({ pending: true }),
    });

    fail = false;
    anchor = 'retry-frontier';
    controller.showOffset(8);
    await settle(controller);
    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, offset: 8, error: null });
    expect(renderer.project).toHaveBeenLastCalledWith(expect.objectContaining({ height: ROWS }));
    controller.dispose();
  });

  it('coalesces pixel wheel residuals into logical rows', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => viewport(
      value.direction === 'end' ? 63 : value.targetOffset ?? Math.max(0, (value.offset ?? 63) - (value.scrollDeltaRows ?? 0)),
    ));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation());
    controller.handleWheel(-9, 0);
    controller.handleWheel(-27, 0);
    expect(request).not.toHaveBeenCalled();
    callbacks.shift()?.(0);
    await settle(controller);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ direction: 'backward', targetOffset: 61 });
    controller.dispose();
  });

  it('renders a cached wheel target inside the controller animation frame', async () => {
    const totalRows = 300;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = {
      apply: vi.fn(),
      project: vi.fn(),
      projectInCurrentAnimationFrame: vi.fn(),
      getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }),
    };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(200);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    renderer.project.mockClear();
    renderer.projectInCurrentAnimationFrame.mockClear();

    controller.handleWheel(-360, 0);
    expect(renderer.project).not.toHaveBeenCalled();
    expect(renderer.projectInCurrentAnimationFrame).not.toHaveBeenCalled();
    callbacks.shift()?.(0);

    expect(controller.getState()).toMatchObject({ browsing: true, offset: 180, error: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(renderer.project).not.toHaveBeenCalled();
    expect(renderer.projectInCurrentAnimationFrame).toHaveBeenCalledOnce();
    expect(renderer.projectInCurrentAnimationFrame).toHaveBeenLastCalledWith(expect.objectContaining({
      history: expect.objectContaining({ totalRows }),
    }));
    controller.dispose();
  });

  it('coalesces rapid wheel reversal to one correct cached frame', async () => {
    const totalRows = 300;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = {
      apply: vi.fn(),
      project: vi.fn(),
      projectInCurrentAnimationFrame: vi.fn(),
      getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }),
    };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(200);
    await settle(controller);
    renderer.project.mockClear();
    renderer.projectInCurrentAnimationFrame.mockClear();

    controller.handleWheel(-360, 0);
    controller.handleWheel(180, 0);
    callbacks.shift()?.(0);

    expect(controller.getState()).toMatchObject({ browsing: true, offset: 190, error: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(renderer.project).not.toHaveBeenCalled();
    expect(renderer.projectInCurrentAnimationFrame).toHaveBeenCalledOnce();
    expect(renderer.projectInCurrentAnimationFrame).toHaveBeenCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({
        cells: expect.arrayContaining([{ text: 'row-190', width: 1 }]),
      })]),
    }));
    controller.dispose();
  });

  it('returns to live inside the wheel frame without allowing a stale history paint', async () => {
    const totalRows = 300;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = {
      apply: vi.fn(),
      project: vi.fn(),
      projectInCurrentAnimationFrame: vi.fn(),
      getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }),
    };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(200);
    await settle(controller);
    renderer.project.mockClear();
    renderer.projectInCurrentAnimationFrame.mockClear();

    controller.handleWheel(2_000, 0);
    callbacks.shift()?.(0);

    expect(controller.getState()).toMatchObject({ browsing: false, busy: false, offset: 263, error: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(renderer.project).not.toHaveBeenCalled();
    expect(renderer.projectInCurrentAnimationFrame).toHaveBeenCalledOnce();
    expect(renderer.projectInCurrentAnimationFrame).toHaveBeenCalledWith(null);
    controller.dispose();
  });

  it('reaches a million-row scrollbar target with one direct window RPC', async () => {
    const totalRows = 1_000_037;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(500_000);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      direction: 'end', targetOffset: biasedWindowStart(500_000, FAST_WINDOW_ROWS, -1),
      viewportRows: FAST_WINDOW_ROWS, windowRows: FAST_WINDOW_ROWS,
    });
    expect(controller.getState().offset).toBe(500_000);
    controller.dispose();
  });

  it('falls back to the exact viewport contract when an old runtime rejects a boundary target', async () => {
    const totalRows = 1_000_037;
    let serverOffset = totalRows - ROWS;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if ((value.direction === 'start' || value.direction === 'end') && value.targetOffset !== undefined) {
        throw Object.assign(new Error('failed to read semantic history'), { code: 400 });
      }
      if (value.direction === 'end') serverOffset = totalRows - ROWS;
      else if (value.direction === 'start') serverOffset = 0;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      return viewport(serverOffset, 1, totalRows);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));

    controller.showOffset(500_000);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      direction: 'end', targetOffset: biasedWindowStart(500_000, FAST_WINDOW_ROWS, -1),
      viewportRows: FAST_WINDOW_ROWS, windowRows: FAST_WINDOW_ROWS,
    });
    expect(request.mock.calls[1]?.[0]).toEqual({
      lane: 'viewport', direction: 'end', viewportRows: ROWS,
    });
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      direction: 'backward', targetOffset: 500_000, viewportRows: ROWS,
    });
    expect(controller.getState().offset).toBe(500_000);
    controller.dispose();
  });

  it('does not retry a failed boundary request unless it is the legacy contract rejection', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('RPC transport error'), { code: -1 });
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, 300));

    controller.showOffset(100);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, error: expect.any(Error) });
    controller.dispose();
  });

  it('coalesces hundreds of rapid long-distance intents across high-latency responses', async () => {
    const totalRows = 1_000_037;
    const pending: Array<Readonly<{
      request: SemanticHistoryRequest;
      resolve: (value: SemanticHistoryViewport) => void;
    }>> = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => await new Promise<SemanticHistoryViewport>(resolve => {
      pending.push({ request: value, resolve });
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(900_000);
    for (let attempt = 0; attempt < 20 && pending.length === 0; attempt += 1) await Promise.resolve();
    for (let index = 0; index < 400; index += 1) {
      controller.showOffset(index % 2 === 0 ? 100_000 + index : 800_000 - index);
    }
    const finalTarget = 456_789;
    controller.showOffset(finalTarget);
    pending[0]!.resolve(windowForRequest(pending[0]!.request, totalRows, 1));
    for (let attempt = 0; attempt < 30 && pending.length < 2; attempt += 1) await Promise.resolve();
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(windowForRequest(pending[1]!.request, totalRows, 1));
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      targetOffset: biasedWindowStart(finalTarget, FAST_WINDOW_ROWS, -1),
      viewportRows: FAST_WINDOW_ROWS,
    });
    expect(controller.getState().offset).toBe(finalTarget);
    expect(renderer.project).toHaveBeenLastCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({
        cells: expect.arrayContaining([{ text: `row-${finalTarget}`, width: 1 }]),
      })]),
    }));
    controller.dispose();
  });

  it('coalesces a 200-row wheel burst into one target window request', async () => {
    const totalRows = 1_000;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));

    for (let index = 0; index < 200; index += 1) controller.handleWheel(-18, 0);
    expect(request).not.toHaveBeenCalled();
    callbacks.shift()?.(0);
    await settle(controller);

    const target = totalRows - ROWS - 200;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      viewportRows: FAST_WINDOW_ROWS,
      windowRows: FAST_WINDOW_ROWS,
    });
    expect(controller.getState().offset).toBe(target);
    controller.dispose();
  });

  it('uses exact targeting only for one large jump, then returns to window reuse', async () => {
    const totalRows = 1_000;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => ({
      ...(value.windowRows === undefined
        ? viewport(value.targetOffset ?? totalRows - ROWS, 1, totalRows)
        : windowForRequest(value, totalRows)),
      anchor: value.windowRows === undefined ? 'exact-frontier' : 'window-frontier',
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));

    controller.handleWheel(-9000, 0);
    callbacks.shift()?.(0);
    await settle(controller);
    expect(request.mock.calls[0]?.[0].windowRows).toBeUndefined();

    controller.scrollByRows(-9);
    await settle(controller);
    expect(request.mock.calls[request.mock.calls.length - 1]?.[0]).toMatchObject({
      windowRows: FAST_WINDOW_ROWS, viewportRows: FAST_WINDOW_ROWS,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ browsing: true, error: null });
    expect(controller.getViewport()?.anchor).toBe('window-frontier');
    controller.dispose();
  });

  it('decays from a 20x burst window to the 10x default window', async () => {
    const totalRows = 1_000;
    let now = 0;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => ({
      ...(value.windowRows === undefined
        ? viewport(value.targetOffset ?? totalRows - ROWS, 1, totalRows)
        : windowForRequest(value, totalRows)),
      anchor: value.windowRows === undefined ? 'exact-frontier' : 'window-frontier',
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({
      renderer,
      request,
      now: () => now,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));

    controller.handleWheel(-9_000, 0);
    callbacks.shift()?.(0);
    await settle(controller);
    expect(request.mock.calls[0]?.[0].windowRows).toBeUndefined();

    now = 600;
    controller.scrollByRows(-9);
    await settle(controller);

    expect(request.mock.calls[1]?.[0]).toMatchObject({
      viewportRows: WINDOW_ROWS,
      windowRows: WINDOW_ROWS,
    });
    controller.dispose();
  });

  it('biases a 10x window toward the current scroll direction', async () => {
    const totalRows = 2_000;
    let now = 0;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request, now: () => now });
    controller.apply(presentation(1, totalRows));
    controller.showViewport(viewport(1_000, 1, totalRows));

    now = 600;
    controller.scrollByRows(9);
    await settle(controller);

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      targetOffset: biasedWindowStart(1_009, WINDOW_ROWS, 1),
      viewportRows: WINDOW_ROWS,
    });
    controller.dispose();
  });

  it('shrinks an adaptive window before its estimated rows exceed the session cache budget', async () => {
    const totalRows = 10_000;
    const base = presentation(1, totalRows);
    const heavy: SemanticPresentation = {
      ...base,
      frame: {
        ...base.frame,
        rows: base.frame.rows.map(row => ({
          ...row,
          cells: row.cells.map(cell => ({ ...cell, text: 'x'.repeat(100) })),
        })),
      },
    };
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(heavy);

    controller.scrollByRows(-9);
    await settle(controller);

    const requestedRows = request.mock.calls[0]?.[0].windowRows ?? 0;
    expect(requestedRows).toBeGreaterThanOrEqual(ROWS);
    expect(requestedRows).toBeLessThanOrEqual(WINDOW_ROWS);
    expect(controller.getCacheMetrics().extraBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    controller.dispose();
  });

  it('starts an exact jump from a fresh boundary after live output changes the revision', async () => {
    let revision = 1;
    let totalRows = 1_000;
    let boundary = 0;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'start' || value.direction === 'end') boundary += 1;
      return viewport(
        value.targetOffset ?? totalRows - ROWS,
        revision,
        totalRows,
        `exact-frontier-${boundary}`,
      );
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(revision, totalRows));

    controller.handleWheel(-1_800, 0);
    callbacks.shift()?.(0);
    await settle(controller);
    controller.showLatest();

    revision = 2;
    totalRows = 1_001;
    controller.apply(presentation(revision, totalRows));
    controller.handleWheel(-1_800, 0);
    callbacks.shift()?.(0);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ direction: 'end', viewportRows: ROWS });
    expect(request.mock.calls[1]?.[0]).not.toHaveProperty('anchor');
    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, offset: 864, error: null });
    expect(controller.getViewport()).toMatchObject({ revision: 2, anchor: 'exact-frontier-2' });
    controller.dispose();
  });

  it('uses a fresh boundary for consecutive uncached exact jumps', async () => {
    const totalRows = 1_000;
    let boundary = 0;
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'start' || value.direction === 'end') boundary += 1;
      return viewport(
        value.targetOffset ?? totalRows - ROWS,
        1,
        totalRows,
        `exact-frontier-${boundary}`,
      );
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({
      renderer,
      request,
      requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; },
      cancelAnimationFrame: vi.fn(),
    });
    controller.apply(presentation(1, totalRows));

    controller.handleWheel(-1_800, 0);
    callbacks.shift()?.(0);
    await settle(controller);
    controller.handleWheel(-1_800, 0);
    callbacks.shift()?.(0);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty('anchor');
    expect(request.mock.calls[1]?.[0]).not.toHaveProperty('anchor');
    expect(request.mock.calls[1]?.[0]).toMatchObject({ direction: 'end', targetOffset: 763, viewportRows: ROWS });
    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, offset: 763, error: null });
    controller.dispose();
  });

  it('retains the hottest disjoint windows while bounding long-distance round trips', async () => {
    const totalRows = 1_000_037;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    const targets = [900_000, 700_000, 500_000, 300_000, 100_000];

    for (const target of targets) {
      controller.showOffset(target);
      await settle(controller);
      expect(controller.getState().offset).toBe(target);
    }
    const coldRequestCount = request.mock.calls.length;
    expect(coldRequestCount).toBe(targets.length);

    for (const target of [...targets].reverse()) {
      controller.showOffset(target);
      await settle(controller);
      expect(controller.getState().offset).toBe(target);
    }

    expect(request.mock.calls.length).toBeLessThanOrEqual(coldRequestCount + 1);
    expect(controller.getCacheMetrics().extraBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    controller.dispose();
  });

  it('retains a verified history window across an immediate return to latest', async () => {
    const totalRows = 300;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(200);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);

    controller.showLatest();
    expect(controller.getState().browsing).toBe(false);
    controller.showOffset(200);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ browsing: true, offset: 200 });
    controller.dispose();
  });

  it('does not project an in-flight history response after returning to latest', async () => {
    let resolveRequest!: (value: SemanticHistoryViewport) => void;
    const request = vi.fn(() => new Promise<SemanticHistoryViewport>(resolve => {
      resolveRequest = resolve;
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, 300));
    controller.showOffset(200);
    await Promise.resolve();
    controller.showLatest();
    resolveRequest(viewport(200, 1, 300));
    await settle(controller);

    expect(controller.getState()).toMatchObject({ browsing: false, busy: false });
    expect(renderer.project).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it('does not project a stale response that is behind a forced top-boundary scroll', async () => {
    const resolvers: Array<(value: SemanticHistoryViewport) => void> = [];
    const request = vi.fn(() => new Promise<SemanticHistoryViewport>(resolve => {
      resolvers.push(resolve);
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, 300));
    controller.showViewport(viewport(200, 1, 300));
    controller.showOffset(150);
    await Promise.resolve();
    controller.showOffset(0);
    resolvers[0]!(viewport(150, 1, 300));
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getViewport()?.offset).toBe(0);
    expect(renderer.project.mock.calls.map(([value]) => value?.history?.screenStartOffset ?? null)).not.toContain(150);
    for (let attempt = 0; attempt < 20 && resolvers.length < 2; attempt += 1) await Promise.resolve();
    resolvers[1]!(viewport(0, 1, 300));
    await settle(controller);
    expect(controller.getViewport()?.offset).toBe(0);
    controller.dispose();
  });

  it('reuses displayed history across live revisions while rows remain valid', async () => {
    let revision = 1;
    let totalRows = 300;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows, revision));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(100);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);

    revision = 2;
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(100);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getViewport()).toMatchObject({ revision: 1, totalRows: 300, offset: 100 });

    revision = 3;
    totalRows = 301;
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(100);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getViewport()).toMatchObject({ revision: 1, totalRows: 300, offset: 100 });
    controller.dispose();
  });

  it('recaptures one fresh boundary when live output expires an anchored history lineage', async () => {
    const revision = 1;
    const totalRows = 2_000;
    let expireNextAnchor = false;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if ((value.direction === 'forward' || value.direction === 'backward') && expireNextAnchor) {
        expireNextAnchor = false;
        throw new SemanticHistoryError('anchor_invalid', 'terminal history anchor expired', {
          cause: Object.assign(new Error('terminal history anchor expired'), { code: 409 }),
        });
      }
      return windowForRequest(value, totalRows, revision);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(100);
    await settle(controller);

    expireNextAnchor = true;
    controller.showOffset(1_500);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ direction: 'forward' });
    expect(request.mock.calls[2]?.[0]).toMatchObject({ direction: 'end' });
    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, offset: 1_500, error: null });
    expect(controller.getViewport()).toMatchObject({ revision: 1, totalRows: 2_000, offset: 1_500 });
    controller.dispose();
  });

  it('starts a fresh boundary capture instead of navigating a stale frontier after live output', async () => {
    let revision = 1;
    let totalRows = 300;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowForRequest(value, totalRows, revision));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(100);
    await settle(controller);

    revision = 2;
    totalRows = 301;
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(200);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getViewport()).toMatchObject({ revision: 1, totalRows: 300, offset: 200 });
    controller.dispose();
  });

  it('displays a fresh target window when live output advances while its boundary request is in flight', async () => {
    let resolveBoundary!: (value: SemanticHistoryViewport) => void;
    let revision = 1;
    let totalRows = 300;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (request.mock.calls.length === 1) {
        return await new Promise<SemanticHistoryViewport>(resolve => {
          resolveBoundary = resolve;
        });
      }
      return windowForRequest(value, totalRows, revision);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(revision, totalRows));
    controller.showOffset(200);
    for (let attempt = 0; attempt < 20 && request.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    const firstRequest = request.mock.calls[0]?.[0];
    expect(firstRequest).toMatchObject({
      direction: 'end', targetOffset: 0, viewportRows: 300,
    });

    revision = 2;
    totalRows = 301;
    controller.apply(presentation(revision, totalRows));
    resolveBoundary(windowForRequest(firstRequest!, 300, 1));
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ browsing: true, busy: false, offset: 200, error: null });
    expect(controller.getViewport()).toMatchObject({ revision: 1, totalRows: 300, offset: 200 });

    controller.scrollByRows(9);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getViewport()).toMatchObject({ revision: 1, totalRows: 300, offset: 209 });
    controller.dispose();
  });

  it('invalidates every cached window when resize advances the geometry generation', async () => {
    let geometryGeneration = 1;
    const request = vi.fn(async (value: SemanticHistoryRequest) => ({
      ...windowForRequest(value, 300),
      geometryGeneration,
    }));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, 300));
    controller.showOffset(100);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);

    geometryGeneration = 2;
    const resized = presentation(1, 300);
    controller.apply({
      ...resized,
      geometry: { ...resized.geometry, generation: geometryGeneration },
    });
    controller.showOffset(100);
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.getViewport()).toMatchObject({ geometryGeneration: 2, offset: 100 });
    controller.dispose();
  });

  it('reuses cached rows by stable ordinal after the live history drops its head', async () => {
    const totalRows = 300;
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowWithHistoryIdentity(
      value.targetOffset ?? 0,
      value.windowRows ?? value.viewportRows,
      1,
      totalRows,
      7,
      1_000,
    ));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentationWithHistoryIdentity(1, totalRows, 7, 1_000));
    controller.showOffset(100);
    await settle(controller);
    expect(controller.getViewport()?.frame.rows[0]?.cells[0]?.text).toBe('ordinal-1100');

    controller.apply(presentationWithHistoryIdentity(2, totalRows, 7, 1_020));
    expect(controller.getState().offset).toBe(80);
    expect(controller.getViewport()?.frame.rows[0]?.cells[0]?.text).toBe('ordinal-1100');

    controller.showOffset(80);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(1);
    expect(controller.getViewport()?.frame.rows[0]?.cells[0]?.text).toBe('ordinal-1100');
    controller.dispose();
  });

  it('invalidates the visible history cache when the history epoch changes', async () => {
    const request = vi.fn(async (value: SemanticHistoryRequest) => windowWithHistoryIdentity(
      value.targetOffset ?? 0,
      value.windowRows ?? value.viewportRows,
      1,
      300,
      3,
      500,
    ));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentationWithHistoryIdentity(1, 300, 3, 500));
    controller.showOffset(100);
    await settle(controller);
    expect(controller.getState().browsing).toBe(true);

    controller.apply(presentationWithHistoryIdentity(2, 300, 4, 500));

    expect(controller.getState().browsing).toBe(false);
    expect(controller.getCacheMetrics().entries).toBe(0);
    expect(renderer.project).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it.each([
    'anchor_invalid',
    'transport_stale',
    'session_detached',
    'attachment_invalid',
    'snapshot_superseded',
  ] as const)('atomically restores latest after typed %s invalidation', async kind => {
    let fail = false;
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (fail) throw new SemanticHistoryError(kind, `typed ${kind}`);
      if (value.direction === 'end') serverOffset = 63;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      return viewport(serverOffset);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.setVisible(false);
    controller.showOffset(54);
    await settle(controller);
    expect(controller.getState().browsing).toBe(true);

    fail = true;
    controller.showOffset(8);
    await settle(controller);

    expect(controller.getState()).toMatchObject({
      browsing: false,
      busy: false,
      error: expect.objectContaining({ kind }),
    });
    expect(controller.getViewport()).toBeNull();
    expect(renderer.project).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it('keeps one frontier lineage while atomic viewport revisions advance with live output', async () => {
    let revision = 1;
    const request = vi.fn(async (value: SemanticHistoryRequest) => viewport(
      value.direction === 'end' ? 63 : value.targetOffset ?? 54,
      revision,
    ));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.setVisible(false);
    controller.showOffset(54);
    await settle(controller);
    revision = 2;

    controller.showOffset(8);
    await settle(controller);

    expect(controller.getState()).toMatchObject({ browsing: true, offset: 8, error: null });
    expect(renderer.project).not.toHaveBeenCalledWith(null);
    controller.dispose();
  });

  it('rejects a changed server frontier from an anchored navigation response', async () => {
    const request = vi.fn(async (value: SemanticHistoryRequest) => viewport(
      value.direction === 'end' ? 63 : value.targetOffset ?? 54,
      1,
      100,
      value.direction === 'end' ? 'frontier' : 'replacement-frontier',
    ));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.setVisible(false);
    controller.showOffset(54);
    await settle(controller);

    expect(controller.getState()).toMatchObject({ browsing: false, error: expect.any(SemanticHistoryError) });
    expect(renderer.project).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it('invalidates view-local history when the attachment transport generation changes', async () => {
    const request = vi.fn(async () => viewport(54));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.setTransportGeneration(7);
    controller.showOffset(54);
    await settle(controller);
    expect(controller.getState().browsing).toBe(true);

    controller.setTransportGeneration(8);

    expect(controller.getState().browsing).toBe(false);
    expect(renderer.project).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it('enforces an independent byte budget for each session without dropping visible viewports', async () => {
    const controllers: HistoryViewportController[] = [];
    const heavyViewport = (offset: number): SemanticHistoryViewport => {
      const value = viewport(offset);
      const hyperlink = `https://cache.test/${'a'.repeat(5000)}`;
      return {
        ...value,
        frame: {
          ...value.frame,
          rows: value.frame.rows.map(row => ({
            cells: row.cells.map(cell => ({ ...cell, hyperlink })),
          })),
        },
      };
    };
    for (let index = 0; index < 20; index += 1) {
      let serverOffset = 63;
      const request = vi.fn(async (value: SemanticHistoryRequest) => {
        if (value.direction === 'end') serverOffset = 63;
        else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
        return heavyViewport(serverOffset);
      });
      const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
      const controller = new HistoryViewportController({ renderer, request });
      controllers.push(controller);
      controller.apply(presentation());
      controller.showOffset(54);
      await settle(controller);
      controller.showOffset(17);
      await settle(controller);
      expect(controller.getState()).toMatchObject({ browsing: true, offset: 17 });
    }
    const totalBytes = controllers.reduce((sum, controller) => sum + controller.getCacheMetrics().bytes, 0);
    expect(totalBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(controllers.every(controller => controller.getCacheMetrics().extraBytes <= 4 * 1024 * 1024)).toBe(true);
    expect(controllers.every(controller => controller.getViewport()?.offset === 17)).toBe(true);
    for (const controller of controllers) controller.dispose();
  });

  it('projects an atomic search result without adopting the search navigation frontier', async () => {
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'end') serverOffset = 63;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      return viewport(serverOffset);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    const result = { ...viewport(8), lane: 'search' as const, anchor: 'search-frontier' };

    controller.showViewport(result);
    expect(controller.getState()).toMatchObject({ browsing: true, offset: 8 });
    expect(renderer.project).toHaveBeenLastCalledWith(result.frame);

    controller.showOffset(7);
    await settle(controller);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ lane: 'viewport', direction: 'end' });
    expect(request.mock.calls.every(call => call[0].anchor !== 'search-frontier')).toBe(true);
    controller.dispose();
  });

  it('evicts an oversized semantic viewport from the extra cache budget while retaining the visible frame', async () => {
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'end') serverOffset = 63;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      const valueText = `https://cache.test/${'a'.repeat(5000)}`;
      const base = viewport(serverOffset);
      return {
        ...base,
        frame: {
          ...base.frame,
          rows: base.frame.rows.map(row => ({ cells: row.cells.map(cell => ({ ...cell, hyperlink: valueText })) })),
        },
      };
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.showOffset(54);
    await settle(controller);
    controller.showOffset(17);
    await settle(controller);

    expect(controller.getViewport()?.offset).toBe(17);
    expect(controller.getCacheMetrics().extraBytes).toBe(0);
    controller.dispose();
  });
});
