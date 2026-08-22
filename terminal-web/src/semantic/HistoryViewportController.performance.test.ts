import { describe, expect, it, vi } from 'vitest';
import { HistoryViewportController } from './HistoryViewportController';
import type {
  SemanticFrame,
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation';

const COLS = 80;
const ROWS = 24;
const TOTAL_ROWS = 10_024;

function frame(offset: number, revision = 1): SemanticFrame {
  return {
    width: COLS,
    height: ROWS,
    bufferKind: 'normal',
    cursor: { x: 0, y: 0, visible: false, shape: 'block', blinking: false },
    history: { revision, totalRows: TOTAL_ROWS, screenStartOffset: TOTAL_ROWS - ROWS },
    graphics: { generation: 0, images: [], placements: [] },
    rows: Array.from({ length: ROWS }, (_, row) => ({
      cells: Array.from({ length: COLS }, (_, column) => ({
        text: column === 0 ? `row-${offset + row}` : '',
        width: 1,
      })),
    })),
  };
}

function presentation(): SemanticPresentation {
  return {
    sequence: 1,
    geometry: { generation: 1, cols: COLS, rows: ROWS },
    state: { sequence: 1, contentEpoch: 0 },
    frame: frame(TOTAL_ROWS - ROWS),
  };
}

function viewport(offset: number): SemanticHistoryViewport {
  return {
    snapshotId: `snapshot-${offset}`,
    lane: 'viewport',
    revision: 1,
    transportGeneration: 1,
    contentEpoch: 0,
    geometryGeneration: 1,
    cols: COLS,
    rows: ROWS,
    anchor: 'frontier',
    firstAvailable: 'first',
    lastAvailable: 'last',
    screenStart: 'screen',
    offset,
    totalRows: TOTAL_ROWS,
    screenStartOffset: TOTAL_ROWS - ROWS,
    hasPrevious: offset > 0,
    hasNext: offset < TOTAL_ROWS - ROWS,
    frame: frame(offset),
  };
}

function renderer() {
  return { apply: vi.fn(), project: vi.fn(), getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }) };
}

async function settle(controller: HistoryViewportController): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Promise.resolve();
    if (!controller.getState().busy) return;
  }
  throw new Error('history controller did not settle');
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? Number.POSITIVE_INFINITY;
}

describe('HistoryViewportController performance bounds', () => {
  it('serves cache hits within one frame and cold loopback seeks within 150ms p95', async () => {
    let serverOffset = TOTAL_ROWS - ROWS;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      if (value.direction === 'end') serverOffset = TOTAL_ROWS - ROWS;
      else if (value.targetOffset !== undefined) serverOffset = value.targetOffset;
      return viewport(serverOffset);
    });
    const controller = new HistoryViewportController({ renderer: renderer(), request });
    controller.apply(presentation());
    controller.showOffset(9000);
    await settle(controller);
    controller.showOffset(8000);
    await settle(controller);
    const setupCalls = request.mock.calls.length;

    const cacheHits: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const start = performance.now();
      controller.showOffset(index % 2 === 0 ? 9000 : 8000);
      cacheHits.push(performance.now() - start);
    }
    expect(request).toHaveBeenCalledTimes(setupCalls);
    expect(percentile(cacheHits, 0.95)).toBeLessThan(32);

    const cold: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const start = performance.now();
      controller.showOffset(7000 - index * 31);
      await settle(controller);
      cold.push(performance.now() - start);
    }
    expect(percentile(cold, 0.95)).toBeLessThan(150);
    expect(controller.getCacheMetrics().extraBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    controller.dispose();
  });

  it('admits at most two history RPCs globally while every view keeps one serial lane', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const controllers = Array.from({ length: 3 }, () => {
      const request = vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active -= 1;
        return viewport(0);
      });
      const controller = new HistoryViewportController({ renderer: renderer(), request });
      controller.apply(presentation());
      return controller;
    });
    for (const controller of controllers) controller.showStart();
    for (let attempt = 0; attempt < 20 && releases.length < 2; attempt += 1) await Promise.resolve();
    expect(releases).toHaveLength(2);
    expect(maximumActive).toBe(2);
    releases.shift()?.();
    for (let attempt = 0; attempt < 20 && releases.length < 2; attempt += 1) await Promise.resolve();
    while (releases.length > 0) releases.shift()?.();
    await Promise.all(controllers.map(settle));
    expect(maximumActive).toBe(2);
    for (const controller of controllers) controller.dispose();
  });
});
