import { describe, expect, it, vi } from 'vitest';
import { HistoryViewportController } from './HistoryViewportController';
import type { SemanticFrame, SemanticHistoryRequest, SemanticHistoryViewport, SemanticPresentation } from './presentation';

const COLS = 80;
const ROWS = 24;
const TOTAL_ROWS = 10_000;

const frame = (offset: number): SemanticFrame => ({
  width: COLS,
  height: ROWS,
  bufferKind: 'normal',
  cursor: { x: 0, y: 0, visible: false, shape: 'block', blinking: false },
  history: { revision: 1, totalRows: TOTAL_ROWS, screenStartOffset: TOTAL_ROWS - ROWS },
  graphics: { generation: 0, images: [], placements: [] },
  rows: Array.from({ length: ROWS }, (_, row) => ({
    cells: Array.from({ length: COLS }, (_, column) => ({ text: column === 0 ? `row-${offset + row}` : '', width: 1 })),
  })),
});

const presentation = (): SemanticPresentation => ({
  sequence: 1,
  geometry: { generation: 1, cols: COLS, rows: ROWS },
  state: { sequence: 1, contentEpoch: 0 },
  frame: frame(TOTAL_ROWS - ROWS),
});

const viewport = (offset: number): SemanticHistoryViewport => ({
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
});

const wait = (duration: number): Promise<void> => new Promise(resolve => setTimeout(resolve, duration));

describe('HistoryViewportController remote latency', () => {
  it('advances the pending skeleton phase with each wheel target while the request is in flight', async () => {
    const projectInCurrentAnimationFrame = vi.fn();
    const renderer = {
      apply: vi.fn(),
      project: vi.fn(),
      projectInCurrentAnimationFrame,
      getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }),
    };
    const request = vi.fn(() => new Promise<SemanticHistoryViewport>(() => {}));
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());

    controller.handleWheel(-1, 1);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const firstPending = projectInCurrentAnimationFrame.mock.lastCall?.[0] as SemanticFrame;

    controller.handleWheel(-1, 1);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const secondPending = projectInCurrentAnimationFrame.mock.lastCall?.[0] as SemanticFrame;

    expect(firstPending.history.pending).toBe(true);
    expect(secondPending.history.pending).toBe(true);
    expect(secondPending.history.pendingOffset).toBe(firstPending.history.pendingOffset! - 1);
    expect(secondPending.history.pendingOffset).not.toBe(firstPending.history.pendingOffset);
    controller.dispose();
  });

  it('projects the wheel target before a 1.5 second history response arrives', async () => {
    const projectInCurrentAnimationFrame = vi.fn();
    const renderer = {
      apply: vi.fn(),
      project: vi.fn(),
      projectInCurrentAnimationFrame,
      getCellMetrics: () => ({ cellWidthCssPx: 9, cellHeightCssPx: 18 }),
    };
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      await wait(1500);
      return viewport(value.targetOffset ?? 0);
    });
    const controller = new HistoryViewportController({ renderer, request });
    controller.apply(presentation());

    controller.handleWheel(-ROWS, 1);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    const target = TOTAL_ROWS - ROWS - ROWS;
    expect(controller.getState()).toMatchObject({ browsing: true, busy: true, offset: target });
    expect(projectInCurrentAnimationFrame).toHaveBeenCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({
        cells: expect.arrayContaining([expect.objectContaining({ text: '' })]),
      })]),
      history: expect.objectContaining({ pending: true }),
    }));

    await wait(1550);
    expect(controller.getState()).toMatchObject({ busy: false, offset: target, error: null });
    expect(controller.getViewport()).toMatchObject({ snapshotId: `snapshot-${target}`, offset: target });
    expect(renderer.project).toHaveBeenLastCalledWith(expect.objectContaining({
      rows: expect.arrayContaining([expect.objectContaining({ cells: expect.arrayContaining([{ text: `row-${target}`, width: 1 }]) })]),
    }));
    controller.dispose();
  }, 10_000);
});
