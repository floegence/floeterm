import { describe, expect, it, vi } from 'vitest';
import { HistoryViewportController } from './HistoryViewportController';
import type {
  SemanticFrame,
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation';

const COLS = 103;
const ROWS = 37;

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

function viewport(offset: number, revision = 1, totalRows = 100): SemanticHistoryViewport {
  const screenStartOffset = totalRows - ROWS;
  return {
    snapshotId: `snapshot-${offset}-${revision}`,
    revision,
    transportGeneration: 7,
    contentEpoch: 0,
    geometryGeneration: 1,
    cols: COLS,
    rows: ROWS,
    anchor: 'frontier',
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

async function settle(controller: HistoryViewportController): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Promise.resolve();
    if (!controller.getState().busy) return;
  }
  throw new Error('history controller did not settle');
}

describe('HistoryViewportController', () => {
  it('separates a 9-row scroll delta from the complete 103x37 viewport and preserves it across live output', async () => {
    let serverOffset: number | null = null;
    const requests: SemanticHistoryRequest[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      requests.push(value);
      if (value.direction === 'end') serverOffset = 63;
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

    expect(requests[0]).toEqual({ direction: 'end', viewportRows: 37 });
    expect(requests[1]).toEqual({
      direction: 'backward', anchor: 'frontier', offset: 63, scrollDeltaRows: 9, viewportRows: 37,
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

  it('serves a prefetched full viewport from the view-local cache without another RPC', async () => {
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'end') serverOffset = 63;
      else if (value.direction === 'backward') serverOffset -= value.scrollDeltaRows ?? 0;
      else if (value.direction === 'forward') serverOffset += value.scrollDeltaRows ?? 0;
      return viewport(serverOffset);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.scrollByRows(-9);
    await settle(controller);
    const afterPrefetch = request.mock.calls.length;
    expect(request.mock.calls.some(call => call[0].scrollDeltaRows === 37)).toBe(true);

    controller.setVisible(false);
    controller.showOffset(17);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(afterPrefetch);
    expect(controller.getState().offset).toBe(17);
    controller.dispose();
  });

  it('keeps the last complete viewport and releases busy when a cache miss fails', async () => {
    let fail = false;
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (fail) throw new Error('RPC transport error');
      if (value.direction === 'end') serverOffset = 63;
      else if (value.direction === 'backward') serverOffset -= value.scrollDeltaRows ?? 0;
      return viewport(serverOffset);
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
    expect(renderer.project.mock.calls[renderer.project.mock.calls.length - 1]?.[0]).toBe(visible);
    controller.dispose();
  });

  it('coalesces pixel wheel residuals into logical rows', async () => {
    const callbacks: FrameRequestCallback[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => viewport(
      value.direction === 'end' ? 63 : Math.max(0, (value.offset ?? 63) - (value.scrollDeltaRows ?? 0)),
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
    expect(request.mock.calls[1]?.[0]).toMatchObject({ direction: 'backward', scrollDeltaRows: 2 });
    controller.dispose();
  });

  it('reaches a distant scrollbar target through bounded actor steps', async () => {
    const totalRows = 1000;
    let serverOffset = totalRows - ROWS;
    let callCount = 0;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      callCount += 1;
      if (callCount > 20) throw new Error(`unbounded history request lane at offset ${serverOffset}`);
      if (value.direction === 'end') serverOffset = totalRows - ROWS;
      else if (value.direction === 'start') serverOffset = 0;
      else if (value.direction === 'backward') serverOffset -= value.scrollDeltaRows ?? 0;
      else serverOffset += value.scrollDeltaRows ?? 0;
      return viewport(serverOffset, 1, totalRows);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.scrollByRows(-9);
    await settle(controller);
    controller.setVisible(false);

    controller.showOffset(7);
    await settle(controller);

    const deltas = request.mock.calls.map(call => call[0].scrollDeltaRows).filter(Boolean) as number[];
    expect(Math.max(...deltas)).toBeLessThanOrEqual(200);
    expect(controller.getState().offset).toBe(7);
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
});
