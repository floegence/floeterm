import { describe, expect, it, vi } from 'vitest';
import { HistorySearchController } from './HistorySearchController';
import type {
  SemanticFrame,
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation';

const COLS = 8;
const ROWS = 3;

function frame(offset: number, revision: number, totalRows = 12): SemanticFrame {
  return {
    width: COLS,
    height: ROWS,
    bufferKind: 'normal',
    cursor: { x: 0, y: 0, visible: false, shape: 'block', blinking: false },
    history: { revision, totalRows, screenStartOffset: totalRows - ROWS },
    graphics: { generation: 0, images: [], placements: [] },
    rows: Array.from({ length: ROWS }, (_, row) => ({
      cells: Array.from({ length: COLS }, (_, column) => ({
        text: column === 0 ? `match-${offset + row}` : '',
        width: 1,
      })),
    })),
  };
}

function presentation(sequence = 1, totalRows = 12): SemanticPresentation {
  return {
    sequence,
    geometry: { generation: 1, cols: COLS, rows: ROWS },
    state: { sequence, contentEpoch: 0 },
    frame: frame(totalRows - ROWS, sequence, totalRows),
  };
}

function viewport(
  offset: number,
  revision: number,
  anchor = 'search-frontier',
  totalRows = 12,
): SemanticHistoryViewport {
  const screenStartOffset = totalRows - ROWS;
  return {
    snapshotId: `search-${offset}-${revision}`,
    lane: 'search',
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

describe('HistorySearchController', () => {
  it('uses an isolated search lane and completes against a bounded scrollback frontier while live revisions advance', async () => {
    let revision = 0;
    const requests: SemanticHistoryRequest[] = [];
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      requests.push(value);
      revision += 1;
      return viewport(value.direction === 'start' ? 0 : value.targetOffset ?? 0, revision);
    });
    const controller = new HistorySearchController({ request });
    controller.setTransportGeneration(7);
    controller.apply(presentation());

    const result = await controller.search('match');

    expect(requests).toHaveLength(3);
    expect(requests.every(item => item.lane === 'search')).toBe(true);
    expect(requests.map(item => item.targetOffset)).toEqual([undefined, 3, 6]);
    expect(requests[1]).toMatchObject({
      anchor: 'search-frontier', snapshotId: 'search-0-1', offset: 0,
    });
    expect(result.matches).toHaveLength(12);
    expect(result.matches.map(match => match.live)).toEqual([
      false, false, false, false, false, false, false, false, false,
      true, true, true,
    ]);

    const resolved = await controller.resolveMatch(result.matches[0]!);
    expect(resolved?.offset).toBe(0);
    expect(requests).toHaveLength(4);
    expect(requests[3]).toMatchObject({ lane: 'search', targetOffset: 0, snapshotId: 'search-6-3' });
    controller.dispose();
  });

  it('fails closed when the isolated search frontier changes', async () => {
    let calls = 0;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      calls += 1;
      return viewport(value.direction === 'start' ? 0 : value.targetOffset ?? 0, calls, calls > 1 ? 'replacement' : 'search-frontier');
    });
    const controller = new HistorySearchController({ request });
    controller.apply(presentation());

    await expect(controller.search('match')).rejects.toMatchObject({ kind: 'snapshot_superseded' });
    expect(request).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('supersedes an older query without starting a second concurrent request lane', async () => {
    let release: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const request = vi.fn(async (value: SemanticHistoryRequest) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (request.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      active -= 1;
      return viewport(value.direction === 'start' ? 0 : value.targetOffset ?? 0, request.mock.calls.length);
    });
    const controller = new HistorySearchController({ request });
    controller.apply(presentation());
    const first = controller.search('first');
    for (let attempt = 0; attempt < 20 && request.mock.calls.length === 0; attempt += 1) await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    const second = controller.search('match');
    release?.();

    await expect(first).rejects.toMatchObject({ kind: 'snapshot_superseded' });
    await expect(second).resolves.toMatchObject({ query: 'match' });
    expect(maximumActive).toBe(1);
    controller.dispose();
  });
});
