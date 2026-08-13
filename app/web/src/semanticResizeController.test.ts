import { describe, expect, it, vi } from 'vitest';

import { createSemanticResizeController } from './semanticResizeController';

const flushTasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitUntil = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushTasks();
  }
  throw new Error('condition did not settle');
};

describe('semantic resize controller', () => {
  it('fences a synchronous superseded lifecycle event while one attach is starting', async () => {
    let controller: ReturnType<typeof createSemanticResizeController>;
    const attach = vi.fn(async () => {
      controller.handleClosed('superseded');
      return { generation: 1, outputSequenceBoundary: 0, cols: 100, rows: 30 };
    });
    controller = createSemanticResizeController({
      measure: () => ({ cols: 100, rows: 30 }),
      repaint: vi.fn(),
      attach,
      resize: vi.fn(async size => ({ generation: 2, outputSequenceBoundary: 0, ...size })),
      onConnectionChange: vi.fn(),
      onGeometry: vi.fn(),
      onError: vi.fn(),
    });

    await controller.requestResize();

    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('reattaches once and applies the latest size when an in-flight resize loses its transport', async () => {
    let size = { cols: 80, rows: 24 };
    let releaseFailedResize: (() => void) | undefined;
    const attach = vi.fn(async (next: { cols: number; rows: number }) => ({
      generation: attach.mock.calls.length,
      outputSequenceBoundary: attach.mock.calls.length === 1 ? 0 : 7,
      ...next,
    }));
    const resize = vi.fn(async () => {
      await new Promise<void>(resolve => { releaseFailedResize = resolve; });
      throw new Error('terminal live session is not attached');
    });
    const onGeometry = vi.fn();
    const onError = vi.fn();
    const controller = createSemanticResizeController({
      measure: () => size,
      repaint: vi.fn(),
      attach,
      resize,
      onConnectionChange: vi.fn(),
      onGeometry,
      onError,
    });

    await controller.requestResize();
    size = { cols: 100, rows: 30 };
    const first = controller.requestResize();
    await waitUntil(() => resize.mock.calls.length === 1);
    size = { cols: 132, rows: 41 };
    const latest = controller.requestResize();
    releaseFailedResize?.();
    await Promise.all([first, latest]);

    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 30 });
    expect(onGeometry).toHaveBeenLastCalledWith({
      generation: 2,
      outputSequenceBoundary: 7,
      cols: 132,
      rows: 41,
    });
    expect(onError).toHaveBeenLastCalledWith('');
  });

  it('does not enqueue the same size again while its resize is in flight', async () => {
    let size = { cols: 80, rows: 24 };
    let settleResize: ((geometry: { generation: number; outputSequenceBoundary: number; cols: number; rows: number }) => void) | undefined;
    const resize = vi.fn((size: { cols: number; rows: number }) => new Promise<{
      generation: number;
      outputSequenceBoundary: number;
      cols: number;
      rows: number;
    }>(resolve => {
      settleResize = resolve;
      void size;
    }));
    const controller = createSemanticResizeController({
      measure: () => size,
      repaint: vi.fn(),
      attach: vi.fn(async next => ({ generation: 1, outputSequenceBoundary: 0, ...next })),
      resize,
      onConnectionChange: vi.fn(),
      onGeometry: vi.fn(),
      onError: vi.fn(),
    });

    await controller.requestResize();
    size = { cols: 120, rows: 40 };
    const first = controller.requestResize();
    await waitUntil(() => resize.mock.calls.length === 1);
    const duplicate = controller.requestResize();
    await flushTasks();
    expect(resize).toHaveBeenCalledTimes(1);
    settleResize?.({ generation: 2, outputSequenceBoundary: 4, cols: 120, rows: 40 });
    await Promise.all([first, duplicate]);

    expect(resize).toHaveBeenCalledTimes(1);
  });

  it('drops an obsolete queued size when dragging back to the in-flight size', async () => {
    let size = { cols: 80, rows: 24 };
    let settleResize: ((geometry: { generation: number; outputSequenceBoundary: number; cols: number; rows: number }) => void) | undefined;
    const resize = vi.fn((next: { cols: number; rows: number }) => new Promise<{
      generation: number;
      outputSequenceBoundary: number;
      cols: number;
      rows: number;
    }>(resolve => {
      settleResize = resolve;
      void next;
    }));
    const controller = createSemanticResizeController({
      measure: () => size,
      repaint: vi.fn(),
      attach: vi.fn(async next => ({ generation: 1, outputSequenceBoundary: 0, ...next })),
      resize,
      onConnectionChange: vi.fn(),
      onGeometry: vi.fn(),
      onError: vi.fn(),
    });

    await controller.requestResize();
    size = { cols: 100, rows: 30 };
    const first = controller.requestResize();
    await waitUntil(() => resize.mock.calls.length === 1);
    size = { cols: 140, rows: 45 };
    const obsolete = controller.requestResize();
    size = { cols: 100, rows: 30 };
    const latest = controller.requestResize();
    settleResize?.({ generation: 2, outputSequenceBoundary: 4, ...size });
    await Promise.all([first, obsolete, latest]);

    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 30 });
  });

  it('reattaches at the latest size when the connection closes during resize', async () => {
    let size = { cols: 80, rows: 24 };
    let rejectResize: ((error: Error) => void) | undefined;
    const attach = vi.fn(async (next: { cols: number; rows: number }) => ({
      generation: attach.mock.calls.length,
      outputSequenceBoundary: 0,
      ...next,
    }));
    const resize = vi.fn(() => new Promise<{
      generation: number;
      outputSequenceBoundary: number;
      cols: number;
      rows: number;
    }>((_resolve, reject) => { rejectResize = reject; }));
    const onError = vi.fn();
    const controller = createSemanticResizeController({
      measure: () => size,
      repaint: vi.fn(),
      attach,
      resize,
      onConnectionChange: vi.fn(),
      onGeometry: vi.fn(),
      onError,
    });

    await controller.requestResize();
    size = { cols: 120, rows: 38 };
    const resizing = controller.requestResize();
    await waitUntil(() => resize.mock.calls.length === 1);
    size = { cols: 132, rows: 41 };
    controller.handleClosed('stream_ended');
    rejectResize?.(new Error('terminal live connection is closed'));
    await resizing;

    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    expect(onError).toHaveBeenLastCalledWith('');
  });

  it('treats transport geometry as applied before a repeated observer callback', async () => {
    let size = { cols: 80, rows: 24 };
    const resize = vi.fn(async (next: { cols: number; rows: number }) => ({
      generation: 2,
      outputSequenceBoundary: 4,
      ...next,
    }));
    const controller = createSemanticResizeController({
      measure: () => size,
      repaint: vi.fn(),
      attach: vi.fn(async next => ({ generation: 1, outputSequenceBoundary: 0, ...next })),
      resize,
      onConnectionChange: vi.fn(),
      onGeometry: vi.fn(),
      onError: vi.fn(),
    });
    await controller.requestResize();
    size = { cols: 132, rows: 41 };
    controller.handleGeometry({ generation: 2, outputSequenceBoundary: 4, ...size });
    await controller.requestResize();

    expect(resize).not.toHaveBeenCalled();
  });
});
