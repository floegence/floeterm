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

    expect(requests[0]).toEqual({ lane: 'viewport', direction: 'end', viewportRows: 37 });
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

  it('serves a prefetched full viewport from the view-local cache without another RPC', async () => {
    let serverOffset = 63;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'end') serverOffset = 63;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
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
    expect(request.mock.calls.some(call => call[0].targetOffset === 17)).toBe(true);

    controller.showOffset(17);
    await settle(controller);
    expect(request).toHaveBeenCalledTimes(afterPrefetch);
    expect(controller.getState().offset).toBe(17);
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
    expect(renderer.project.mock.calls[renderer.project.mock.calls.length - 1]?.[0]).toBe(visible);

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

  it('reaches a million-row scrollbar target with one direct seek RPC', async () => {
    const totalRows = 1_000_037;
    let serverOffset = totalRows - ROWS;
    let callCount = 0;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      callCount += 1;
      if (value.direction === 'end') serverOffset = totalRows - ROWS;
      else if (value.direction === 'start') serverOffset = 0;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      else if (value.direction === 'backward') serverOffset -= value.scrollDeltaRows ?? 0;
      else serverOffset += value.scrollDeltaRows ?? 0;
      return viewport(serverOffset, 1, totalRows);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.setVisible(false);
    controller.showOffset(7);
    await settle(controller);

    expect(callCount).toBe(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      direction: 'backward', offset: 1_000_000, targetOffset: 7, viewportRows: ROWS,
    });
    expect(request.mock.calls.some(call => call[0].scrollDeltaRows === 0)).toBe(false);
    expect(controller.getState().offset).toBe(7);
    controller.dispose();
  });

  it('coalesces a rapid rail supersede across a high-latency frontier response', async () => {
    const totalRows = 1_000_037;
    let resolveFrontier: ((value: SemanticHistoryViewport) => void) | undefined;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'end') {
        return await new Promise<SemanticHistoryViewport>(resolve => { resolveFrontier = resolve; });
      }
      return viewport(value.targetOffset ?? 0, 2, totalRows);
    });
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation(1, totalRows));
    controller.showOffset(7);
    for (let attempt = 0; attempt < 20 && request.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    controller.showOffset(13);
    resolveFrontier?.(viewport(totalRows - ROWS, 1, totalRows));
    await settle(controller);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ targetOffset: 13 });
    expect(request.mock.calls.some(call => call[0].scrollDeltaRows === 0)).toBe(false);
    expect(controller.getState().offset).toBe(13);
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

  it('rejects a changed server frontier instead of mixing cache lineages', async () => {
    let anchor = 'frontier';
    const request = vi.fn(async (value: SemanticHistoryRequest) => viewport(
      value.direction === 'end' ? 63 : value.targetOffset ?? 54,
      1,
      100,
      anchor,
    ));
    const renderer = { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());
    controller.setVisible(false);
    controller.showOffset(54);
    await settle(controller);
    anchor = 'replacement-frontier';

    controller.showOffset(8);
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

  it('enforces byte-accounted view and global cache budgets without dropping the visible viewport', async () => {
    const controllers: HistoryViewportController[] = [];
    const heavyViewport = (offset: number): SemanticHistoryViewport => {
      const value = viewport(offset);
      const hyperlink = `https://cache.test/${'a'.repeat(220)}`;
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
    for (let index = 0; index < 5; index += 1) {
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
    expect(totalBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
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
      const valueText = `https://cache.test/${'a'.repeat(600)}`;
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
