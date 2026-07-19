// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalInstance } from './TerminalInstanceController';
import {
  TerminalState,
  type TerminalCoreLike,
  type TerminalDataEvent,
  type TerminalEventHandlers,
  type TerminalEventSource,
  type TerminalFocusOptions,
  type TerminalInitializationOptions,
  type TerminalHistoryPage,
  type TerminalGeometryEvent,
  type TerminalInstanceOptions,
  type TerminalInstanceSnapshot,
  type TerminalTransport,
} from '../types';

type MockCoreOptions = {
  container: HTMLElement;
  eventHandlers?: TerminalEventHandlers;
};

const coreInstances: MockCore[] = [];

const flushPromises = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

class MockCore implements TerminalCoreLike {
  state = TerminalState.READY;
  dimensions = { cols: 100, rows: 30 };
  writes: Array<string | Uint8Array> = [];
  disposed = false;
  connected = false;
  historyReplayStarted = 0;
  historyReplayEnded = 0;
  appearanceCalls: unknown[] = [];
  fixedDimensionCalls: Array<{ cols: number; rows: number } | null> = [];
  focusCalls: Array<TerminalFocusOptions | undefined> = [];
  readonly config?: unknown;
  readonly container: HTMLElement;
  readonly eventHandlers?: TerminalEventHandlers;

  constructor(container: HTMLElement, config?: unknown, eventHandlers?: TerminalEventHandlers) {
    this.container = container;
    this.config = config;
    this.eventHandlers = eventHandlers;
    coreInstances.push(this);
  }

  async initialize(): Promise<void> {
    this.eventHandlers?.onStateChange?.(TerminalState.READY);
    this.eventHandlers?.onResize?.(this.dimensions);
  }

  dispose(): void {
    this.disposed = true;
    this.state = TerminalState.DISPOSED;
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes.push(data);
    callback?.();
  }
  writeFrame(data: string | Uint8Array, callback?: () => void): void {
    this.write(data, callback);
  }

  clear(): void {}
  serialize(): string { return ''; }
  getSelectionText(): string { return ''; }
  hasSelection(): boolean { return false; }
  async copySelection() { return { copied: false as const, reason: 'empty_selection' as const, source: 'command' as const }; }
  getState(): TerminalState { return this.state; }
  getDimensions(): { cols: number; rows: number } { return this.dimensions; }
  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null { return null; }
  findNext(): boolean { return false; }
  findPrevious(): boolean { return false; }
  clearSearch(): void {}
  setSearchResultsCallback(): void {}
  focus(options?: TerminalFocusOptions): void { this.focusCalls.push(options); }
  setConnected(isConnected: boolean): void { this.connected = isConnected; }
  forceResize(): void {}
  setFixedDimensions(dimensions: { cols: number; rows: number } | null): void {
    this.fixedDimensionCalls.push(dimensions);
    if (dimensions) this.dimensions = dimensions;
  }
  setAppearance(appearance: unknown): void { this.appearanceCalls.push(appearance); }
  setTheme(): void {}
  setFontSize(): void {}
  setPresentationScale(): void {}
  startHistoryReplay(): void { this.historyReplayStarted += 1; }
  endHistoryReplay(): void { this.historyReplayEnded += 1; }
}

const makeTransport = (overrides: Partial<TerminalTransport> = {}): TerminalTransport => ({
  attach: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  history: vi.fn().mockResolvedValue([]),
  clear: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

const makeEventSource = () => {
  const handlers = new Map<string, (event: TerminalDataEvent) => void>();
  const geometryHandlers = new Map<string, (event: TerminalGeometryEvent) => void>();
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    source: {
      onTerminalData: vi.fn((_sessionId: string, nextHandler: (event: TerminalDataEvent) => void) => {
        handlers.set(_sessionId, nextHandler);
        const unsubscribe = vi.fn(() => handlers.delete(_sessionId));
        unsubscribes.set(_sessionId, unsubscribe);
        return unsubscribe;
      }),
      onTerminalGeometry: vi.fn((_sessionId: string, nextHandler: (event: TerminalGeometryEvent) => void) => {
        geometryHandlers.set(_sessionId, nextHandler);
        return () => geometryHandlers.delete(_sessionId);
      }),
    },
    emit: (event: TerminalDataEvent) => handlers.get(event.sessionId)?.(event),
    emitGeometry: (event: TerminalGeometryEvent) => geometryHandlers.get(event.sessionId)?.(event),
    getUnsubscribe: (sessionId: string) => unsubscribes.get(sessionId),
  };
};

type MountControllerOptions = Partial<MockCoreOptions> & Partial<Pick<TerminalInstanceOptions,
  'sessionId' | 'isActive' | 'transport' | 'eventSource' | 'coreConstructor' | 'config' | 'scheduler' | 'logger'
>> & {
  autoRunTimers?: boolean;
};

const mountController = async (opts: MountControllerOptions = {}) => {
  const transport = opts.transport ?? makeTransport();
  const events = makeEventSource();
  const controller = createTerminalInstance({
    sessionId: opts.sessionId ?? 's1',
    isActive: opts.isActive ?? true,
    transport,
    eventSource: opts.eventSource ?? events.source,
    coreConstructor: opts.coreConstructor ?? MockCore,
    ...(opts.scheduler ? { scheduler: opts.scheduler } : {}),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  const snapshots: TerminalInstanceSnapshot[] = [];
  const unsubscribe = controller.subscribe(snapshot => snapshots.push(snapshot));
  const container = opts?.container ?? document.createElement('div');
  document.body.appendChild(container);

  await controller.mount(container);
  if (opts.autoRunTimers !== false) {
    await vi.runAllTimersAsync();
    await Promise.resolve();
  }

  return { controller, transport, events, snapshots, unsubscribe };
};

describe('TerminalInstanceController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    coreInstances.length = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => (
      setTimeout(() => cb(Date.now()), 0) as unknown as number
    );
    globalThis.cancelAnimationFrame = (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('enters an explicit error state when a large input queue is rejected', async () => {
    const inputError = new Error('terminal live input queue limit exceeded');
    const transport = makeTransport({ sendInput: vi.fn().mockRejectedValue(inputError) });
    const { controller, snapshots } = await mountController({ transport });
    const core = coreInstances[0]!;

    core.eventHandlers?.onData?.('x'.repeat(8 * 1024 * 1024 + 1));
    await flushPromises();

    const finalSnapshot = snapshots[snapshots.length - 1];
    expect(finalSnapshot?.state.state).toBe(TerminalState.ERROR);
    expect(finalSnapshot?.state.error).toBe(inputError);
    controller.dispose();
  });

  it('mounts a terminal, resizes the session, and attaches with current dimensions', async () => {
    const { controller, transport, snapshots, unsubscribe } = await mountController();

    expect(coreInstances).toHaveLength(1);
    expect(transport.resize).toHaveBeenCalledWith('s1', 100, 30);
    expect(transport.attach).toHaveBeenCalledWith('s1', 100, 30);
    expect(controller.getSnapshot().connection.state).toBe('connected');
    expect(snapshots.some(snapshot => snapshot.loadingState === 'attaching')).toBe(true);

    unsubscribe();
    controller.dispose();
  });

  it('replays ordered terminal data and ends history replay after replay-complete drains', async () => {
    const { controller, events } = await mountController();
    const core = coreInstances[0]!;

    events.emit({ sessionId: 's1', type: 'data', sequence: 2, data: new TextEncoder().encode('second') });
    events.emit({ sessionId: 's1', type: 'data', sequence: 1, data: new TextEncoder().encode('first') });
    await vi.runAllTimersAsync();

    expect(core.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['firstsecond']);
    expect(controller.getSnapshot().loadingState).toBe('processing_history');

    events.emit({ sessionId: 's1', type: 'replay-complete', sequence: 2, data: new Uint8Array(0) });
    await vi.runAllTimersAsync();

    expect(core.historyReplayEnded).toBe(1);
    expect(controller.getSnapshot().loadingState).toBe('ready');

    controller.dispose();
  });

  it('renders multiple arrived live protocol batches in one animation frame', async () => {
    const frames: FrameRequestCallback[] = [];
    const { controller, events } = await mountController({
      scheduler: {
        requestFrame: callback => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
      },
    });
    const core = coreInstances[0]!;
    const payload = new Uint8Array(64 * 1024);

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      events.emit({ sessionId: 's1', type: 'data', sequence, data: payload });
    }

    expect(frames).toHaveLength(1);
    frames.shift()!(performance.now());
    await flushPromises();

    expect(core.writes).toHaveLength(1);
    expect((core.writes[0] as Uint8Array).byteLength).toBe(4 * 64 * 1024);

    controller.dispose();
  });

  it('renders an idle small live batch before the next animation frame', async () => {
    const frames: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn();
    const { controller, events } = await mountController({
      scheduler: {
        requestFrame: callback => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame,
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
      },
    });
    events.emit({ sessionId: 's1', type: 'replay-complete', sequence: 0, data: new Uint8Array() });
    await flushPromises();
    frames.length = 0;
    cancelFrame.mockClear();

    events.emit({
      sessionId: 's1',
      type: 'data',
      sequence: 1,
      data: new TextEncoder().encode('x'),
      liveBatchSize: 1,
    });
    await flushPromises();

    expect(coreInstances[0]!.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['x']);
    expect(cancelFrame).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('keeps multiple small records from one live protocol batch in the same animation frame', async () => {
    const frames: FrameRequestCallback[] = [];
    const { controller, events } = await mountController({
      scheduler: {
        requestFrame: callback => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
      },
    });
    events.emit({ sessionId: 's1', type: 'replay-complete', sequence: 0, data: new Uint8Array() });
    await flushPromises();
    frames.length = 0;

    events.emit({
      sessionId: 's1',
      type: 'data',
      sequence: 1,
      data: new TextEncoder().encode('a'),
      liveBatchSize: 2,
    });
    events.emit({
      sessionId: 's1',
      type: 'data',
      sequence: 2,
      data: new TextEncoder().encode('b'),
      liveBatchSize: 2,
    });
    await flushPromises();

    expect(coreInstances[0]!.writes).toHaveLength(0);
    expect(frames).toHaveLength(1);
    frames.shift()!(performance.now());
    await flushPromises();
    expect(coreInstances[0]!.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['ab']);

    controller.dispose();
  });

  it('uses an atomic live boundary and commits history before buffered live output', async () => {
    const history = deferred<TerminalHistoryPage>();
    const attachWithHistoryBoundary = vi.fn().mockResolvedValue({
      historyBoundarySequence: 3,
      historyGeneration: 1,
      historyStartSequence: 1,
    });
    const transport = makeTransport({
      history: vi.fn().mockRejectedValue(new Error('legacy history path must not be used')),
    }) as TerminalTransport & {
      attachWithHistoryBoundary: typeof attachWithHistoryBoundary;
      historyPage: () => Promise<TerminalHistoryPage>;
    };
    transport.attachWithHistoryBoundary = attachWithHistoryBoundary;
    transport.historyPage = vi.fn(() => history.promise);
    const events = makeEventSource();
    const { controller } = await mountController({
      transport,
      eventSource: events.source,
      autoRunTimers: false,
    });
    await flushPromises();

    expect(attachWithHistoryBoundary).toHaveBeenCalledWith('s1', 100, 30);
    expect(transport.attach).not.toHaveBeenCalled();
    expect(transport.resize).not.toHaveBeenCalled();

    events.emit({ sessionId: 's1', type: 'data', sequence: 4, timestampMs: 4, data: new TextEncoder().encode('4') });
    history.resolve({
      chunks: [
        { sequence: 1, timestampMs: 1, data: new TextEncoder().encode('1') },
        { sequence: 2, timestampMs: 2, data: new TextEncoder().encode('2') },
        { sequence: 3, timestampMs: 3, data: new TextEncoder().encode('3') },
      ],
      firstRetainedSequence: 1,
      nextStartSequence: 0,
      hasMore: false,
      coveredThroughSequence: 3,
      snapshotEndSequence: 3,
      historyGeneration: 1,
      historyReset: false,
      historyTruncated: false,
      totalBytes: 3,
    });
    await flushPromises();
    await vi.runAllTimersAsync();

    const core = coreInstances[0]!;
    expect(core.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['1234']);
    expect(core.historyReplayEnded).toBe(1);
    expect(controller.getSnapshot().connection.state).toBe('connected');
    expect(controller.getSnapshot().loadingState).toBe('ready');

    controller.dispose();
  });

  it('fails an atomic attach when history does not cover the acknowledged boundary', async () => {
    const attachWithHistoryBoundary = vi.fn().mockResolvedValue({
      historyBoundarySequence: 3,
      historyGeneration: 1,
      historyStartSequence: 1,
    });
    const transport = makeTransport({
      history: vi.fn().mockRejectedValue(new Error('legacy history path must not be used')),
    }) as TerminalTransport & {
      attachWithHistoryBoundary: typeof attachWithHistoryBoundary;
      historyPage: () => Promise<TerminalHistoryPage>;
    };
    transport.attachWithHistoryBoundary = attachWithHistoryBoundary;
    transport.historyPage = vi.fn().mockResolvedValue({
      chunks: [
        { sequence: 1, timestampMs: 1, data: new TextEncoder().encode('1') },
        { sequence: 3, timestampMs: 3, data: new TextEncoder().encode('3') },
      ],
      firstRetainedSequence: 1,
      nextStartSequence: 0,
      hasMore: false,
      coveredThroughSequence: 3,
      snapshotEndSequence: 3,
      historyGeneration: 1,
      historyReset: false,
      historyTruncated: false,
      totalBytes: 2,
    });
    const { controller } = await mountController({ transport, autoRunTimers: false });
    await flushPromises();

    expect(controller.getSnapshot().connection.state).toBe('failed');
    expect(controller.getSnapshot().connection.error?.message).toMatch(/missing terminal output sequence 2/i);

    controller.dispose();
  });

  it('accepts an empty cleared-history page that explicitly covers the attach boundary', async () => {
    const attachWithHistoryBoundary = vi.fn().mockResolvedValue({
      historyBoundarySequence: 4,
      historyGeneration: 2,
      historyStartSequence: 5,
    });
    const historyPage = vi.fn().mockResolvedValue({
      chunks: [],
      firstRetainedSequence: 0,
      nextStartSequence: 0,
      hasMore: false,
      coveredThroughSequence: 4,
      snapshotEndSequence: 4,
      historyGeneration: 2,
      historyReset: false,
      historyTruncated: false,
      totalBytes: 0,
    });
    const transport = makeTransport({
      history: vi.fn().mockRejectedValue(new Error('legacy history path must not be used')),
    }) as TerminalTransport & {
      attachWithHistoryBoundary: typeof attachWithHistoryBoundary;
      historyPage: typeof historyPage;
    };
    transport.attachWithHistoryBoundary = attachWithHistoryBoundary;
    transport.historyPage = historyPage;
    const events = makeEventSource();
    const { controller } = await mountController({ transport, eventSource: events.source, autoRunTimers: false });
    await flushPromises();

    events.emit({ sessionId: 's1', type: 'data', sequence: 5, timestampMs: 5, data: new TextEncoder().encode('5') });
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(historyPage).not.toHaveBeenCalled();
    expect(controller.getSnapshot().connection.state).toBe('connected');
    expect(coreInstances[0]!.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['5']);

    controller.dispose();
  });

  it('replays non-empty output from the exact start of a cleared history generation', async () => {
    const attachWithHistoryBoundary = vi.fn().mockResolvedValue({
      historyBoundarySequence: 5,
      historyGeneration: 2,
      historyStartSequence: 5,
    });
    const historyPage = vi.fn().mockResolvedValue({
      chunks: [{ sequence: 5, timestampMs: 5, data: new TextEncoder().encode('after-clear') }],
      firstRetainedSequence: 5,
      nextStartSequence: 6,
      hasMore: false,
      coveredThroughSequence: 5,
      snapshotEndSequence: 5,
      historyGeneration: 2,
      historyReset: false,
      historyTruncated: false,
      totalBytes: 11,
    });
    const transport = makeTransport({
      history: vi.fn().mockRejectedValue(new Error('legacy history path must not be used')),
    }) as TerminalTransport & {
      attachWithHistoryBoundary: typeof attachWithHistoryBoundary;
      historyPage: typeof historyPage;
    };
    transport.attachWithHistoryBoundary = attachWithHistoryBoundary;
    transport.historyPage = historyPage;

    const { controller } = await mountController({ transport, autoRunTimers: false });
    await flushPromises();
    await vi.runAllTimersAsync();

    expect(historyPage).toHaveBeenCalledWith('s1', 5, 5, 2);
    expect(coreInstances[0]!.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['after-clear']);
    expect(controller.getSnapshot().connection.state).toBe('connected');

    controller.dispose();
  });

  it('clears local output and server history through the shared action facade', async () => {
    const { controller, transport } = await mountController();

    controller.actions.clear();
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.clear).toHaveBeenCalledWith('s1');
    expect(transport.sendInput).toHaveBeenCalledWith('s1', '\r');

    controller.dispose();
  });

  it('passes focus options through the shared action facade', async () => {
    const { controller } = await mountController();
    const core = coreInstances[0]!;

    controller.actions.focus({ preventScroll: false });

    expect(core.focusCalls).toEqual([{ preventScroll: false }]);

    controller.dispose();
  });

  it('updates appearance without rebuilding the core', async () => {
    const { controller } = await mountController();
    const core = coreInstances[0]!;

    controller.updateOptions({ themeName: 'light', fontSize: 14 });

    expect(coreInstances).toHaveLength(1);
    expect(core.appearanceCalls.length).toBeGreaterThan(0);

    controller.dispose();
  });

  it('reports initialization errors through snapshot and callback', async () => {
    class FailingCore extends MockCore {
      async initialize(): Promise<void> {
        throw new Error('boot failed');
      }
    }
    const onError = vi.fn();
    const transport = makeTransport();
    const events = makeEventSource();
    const controller = createTerminalInstance({
      sessionId: 's1',
      isActive: true,
      transport,
      eventSource: events.source,
      coreConstructor: FailingCore,
      onError,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);

    await controller.mount(container);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(controller.getSnapshot().state.state).toBe(TerminalState.ERROR);
    expect(controller.getSnapshot().loadingState).toBe('ready');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boot failed' }));

    controller.dispose();
  });

  it('does not initialize while inactive, then initializes immediately when activated', async () => {
    const { controller, transport } = await mountController({ isActive: false, autoRunTimers: false });

    await vi.advanceTimersByTimeAsync(500);
    expect(coreInstances).toHaveLength(0);

    controller.updateOptions({ isActive: true });
    expect(coreInstances).toHaveLength(1);
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(coreInstances).toHaveLength(1);
    expect(transport.attach).toHaveBeenCalledWith('s1', 100, 30);

    controller.dispose();
  });

  it('passes framework-neutral config through to the core constructor', async () => {
    const fixedDimensions = { cols: 120, rows: 40 };
    const { controller } = await mountController({
      config: {
        fixedDimensions,
        responsive: {
          fitOnFocus: true,
          emitResizeOnFocus: true,
          notifyResizeOnlyWhenFocused: true,
        },
      },
    });

    expect(coreInstances[0]!.config).toEqual(expect.objectContaining({
      fixedDimensions,
      responsive: expect.objectContaining({ notifyResizeOnlyWhenFocused: true }),
    }));

    controller.dispose();
  });

  it('applies monotonic shared geometry without replacing independent viewport resize reports', async () => {
    const { controller, events, transport } = await mountController({
      config: {
        responsive: {
          reportHostDimensionsWithFixedGrid: true,
        },
      },
    });
    const core = coreInstances[0]!;
    expect(transport.resize).toHaveBeenCalledWith('s1', 100, 30);

    events.emitGeometry({ sessionId: 's1', generation: 2, outputSequenceBoundary: 0, cols: 80, rows: 24 });
    expect(core.fixedDimensionCalls).toEqual([{ cols: 80, rows: 24 }]);

    events.emitGeometry({ sessionId: 's1', generation: 1, outputSequenceBoundary: 0, cols: 120, rows: 40 });
    expect(core.fixedDimensionCalls).toEqual([{ cols: 80, rows: 24 }]);

    core.eventHandlers?.onResize?.({ cols: 110, rows: 35 });
    await flushPromises();
    expect(transport.resize).toHaveBeenLastCalledWith('s1', 110, 35);
    expect(core.fixedDimensionCalls).toEqual([{ cols: 80, rows: 24 }]);

    controller.dispose();
  });

  it('does not report an in-flight resize as a product warning after disposal', async () => {
    const resizeResult = deferred<void>();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const transport = makeTransport({ resize: vi.fn(() => resizeResult.promise) });
    const { controller } = await mountController({ transport, logger, autoRunTimers: false });
    await flushPromises();
    expect(transport.resize).toHaveBeenCalled();

    controller.dispose();
    resizeResult.reject(new Error('connection closed during disposal'));
    await flushPromises();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('applies shared geometry only after output through its boundary is parsed', async () => {
    const frames: FrameRequestCallback[] = [];
    const operations: string[] = [];
    class OrderedCore extends MockCore {
      override writeFrame(data: string | Uint8Array, callback?: () => void): void {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        operations.push(`write:${text}`);
        super.writeFrame(data, callback);
      }

      override setFixedDimensions(dimensions: { cols: number; rows: number } | null): void {
        operations.push(`geometry:${dimensions?.cols ?? 0}x${dimensions?.rows ?? 0}`);
        super.setFixedDimensions(dimensions);
      }
    }
    const { controller, events } = await mountController({
      coreConstructor: OrderedCore,
      config: { responsive: { reportHostDimensionsWithFixedGrid: true } },
      scheduler: {
        requestFrame: callback => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
      },
    });

    events.emit({ sessionId: 's1', type: 'data', sequence: 1, data: new TextEncoder().encode('1') });
    events.emitGeometry({ sessionId: 's1', generation: 2, outputSequenceBoundary: 2, cols: 90, rows: 28 });
    events.emit({ sessionId: 's1', type: 'data', sequence: 2, data: new TextEncoder().encode('2') });

    expect(operations).toEqual([]);
    frames.shift()!(performance.now());
    await flushPromises();
    expect(operations).toEqual(['write:12', 'geometry:90x28']);

    controller.dispose();
  });

  it('splits an output batch at a shared geometry boundary', async () => {
    const frames: FrameRequestCallback[] = [];
    const operations: string[] = [];
    class OrderedCore extends MockCore {
      override writeFrame(data: string | Uint8Array, callback?: () => void): void {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        operations.push(`write:${text}`);
        super.writeFrame(data, callback);
      }

      override setFixedDimensions(dimensions: { cols: number; rows: number } | null): void {
        operations.push(`geometry:${dimensions?.cols ?? 0}x${dimensions?.rows ?? 0}`);
        super.setFixedDimensions(dimensions);
      }
    }
    const { controller, events } = await mountController({
      coreConstructor: OrderedCore,
      config: { responsive: { reportHostDimensionsWithFixedGrid: true } },
      scheduler: {
        requestFrame: callback => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: vi.fn(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: handle => clearTimeout(handle),
      },
    });

    events.emit({ sessionId: 's1', type: 'data', sequence: 1, data: new TextEncoder().encode('old') });
    events.emitGeometry({ sessionId: 's1', generation: 2, outputSequenceBoundary: 1, cols: 90, rows: 28 });
    events.emit({ sessionId: 's1', type: 'data', sequence: 2, data: new TextEncoder().encode('new') });

    frames.shift()!(performance.now());
    await flushPromises();
    expect(operations).toEqual(['write:old', 'geometry:90x28']);
    expect(frames).toHaveLength(1);
    frames.shift()!(performance.now());
    await flushPromises();
    expect(operations).toEqual(['write:old', 'geometry:90x28', 'write:new']);

    controller.dispose();
  });

  it('clears pending shared geometry when the terminal session changes', async () => {
    const { controller, events } = await mountController({
      config: { responsive: { reportHostDimensionsWithFixedGrid: true } },
    });
    const firstCore = coreInstances[0]!;

    events.emitGeometry({ sessionId: 's1', generation: 2, outputSequenceBoundary: 2, cols: 90, rows: 28 });
    controller.updateOptions({ sessionId: 's2' });
    await vi.runAllTimersAsync();
    events.emit({ sessionId: 's2', type: 'data', sequence: 1, data: new TextEncoder().encode('1') });
    events.emit({ sessionId: 's2', type: 'data', sequence: 2, data: new TextEncoder().encode('2') });
    await vi.runAllTimersAsync();

    expect(firstCore.fixedDimensionCalls).toEqual([null]);
    expect(coreInstances[1]!.fixedDimensionCalls).toEqual([]);

    controller.dispose();
  });

  it('passes interactive priority and aborts in-flight initialization when disposed', async () => {
    let initializationOptions: TerminalInitializationOptions | undefined;
    class BlockingCore extends MockCore {
      override initialize(options?: TerminalInitializationOptions): Promise<void> {
        initializationOptions = options;
        return new Promise((_resolve, reject) => {
          const signal = options?.signal;
          const rejectAbort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) {
            rejectAbort();
            return;
          }
          signal?.addEventListener('abort', rejectAbort, { once: true });
        });
      }
    }
    const { controller, events, transport } = await mountController({
      autoRunTimers: false,
      coreConstructor: BlockingCore,
    });

    expect(coreInstances).toHaveLength(1);
    expect(initializationOptions?.priority).toBe('interactive');
    expect(initializationOptions?.signal?.aborted).toBe(false);

    controller.dispose();
    await Promise.resolve();
    await Promise.resolve();

    expect(initializationOptions?.signal?.aborted).toBe(true);
    expect(coreInstances[0]?.disposed).toBe(true);
    expect(transport.attach).not.toHaveBeenCalled();
    expect(events.getUnsubscribe('s1')).toHaveBeenCalledTimes(1);
  });

  it('surfaces attach failures and retries with the current terminal dimensions', async () => {
    const attach = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const transport = makeTransport({ attach });
    const { controller } = await mountController({ transport, autoRunTimers: false });
    await flushPromises();

    expect(controller.getSnapshot().connection.state).toBe('failed');
    expect(controller.getSnapshot().connection.error?.message).toContain('offline');

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(attach).toHaveBeenCalledTimes(2);
    expect(attach).toHaveBeenLastCalledWith('s1', 100, 30);
    expect(controller.getSnapshot().connection.state).toBe('connected');

    controller.dispose();
  });

  it('resets subscriptions and rebuilds the core when the session id changes', async () => {
    const events = makeEventSource();
    const { controller } = await mountController({ eventSource: events.source as TerminalEventSource });
    const firstCore = coreInstances[0]!;

    controller.updateOptions({ sessionId: 's2' });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(events.getUnsubscribe('s1')).toHaveBeenCalledTimes(1);
    expect(firstCore.disposed).toBe(true);
    expect(coreInstances).toHaveLength(2);
    expect(controller.getSnapshot().connection.state).toBe('connected');

    events.emit({ sessionId: 's1', type: 'data', sequence: 1, data: new TextEncoder().encode('old') });
    events.emit({ sessionId: 's2', type: 'data', sequence: 1, data: new TextEncoder().encode('new') });
    await vi.runAllTimersAsync();

    const secondCore = coreInstances[1]!;
    expect(firstCore.writes).toHaveLength(0);
    expect(secondCore.writes.map(item => new TextDecoder().decode(item as Uint8Array))).toEqual(['new']);

    controller.dispose();
  });
});
