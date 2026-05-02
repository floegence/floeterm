// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalInstance } from './TerminalInstanceController';
import {
  TerminalState,
  type TerminalCoreLike,
  type TerminalDataEvent,
  type TerminalEventHandlers,
  type TerminalEventSource,
  type TerminalInstanceOptions,
  type TerminalInstanceSnapshot,
  type TerminalTransport,
} from '../types';

type MockCoreOptions = {
  container: HTMLElement;
  eventHandlers?: TerminalEventHandlers;
};

const coreInstances: MockCore[] = [];

class MockCore implements TerminalCoreLike {
  state = TerminalState.READY;
  dimensions = { cols: 100, rows: 30 };
  writes: Array<string | Uint8Array> = [];
  disposed = false;
  connected = false;
  historyReplayStarted = 0;
  historyReplayEnded = 0;
  appearanceCalls: unknown[] = [];
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
  focus(): void {}
  setConnected(isConnected: boolean): void { this.connected = isConnected; }
  forceResize(): void {}
  setFixedDimensions(): void {}
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
  const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    source: {
      onTerminalData: vi.fn((_sessionId: string, nextHandler: (event: TerminalDataEvent) => void) => {
        handlers.set(_sessionId, nextHandler);
        const unsubscribe = vi.fn(() => handlers.delete(_sessionId));
        unsubscribes.set(_sessionId, unsubscribe);
        return unsubscribe;
      }),
    },
    emit: (event: TerminalDataEvent) => handlers.get(event.sessionId)?.(event),
    getUnsubscribe: (sessionId: string) => unsubscribes.get(sessionId),
  };
};

type MountControllerOptions = Partial<MockCoreOptions> & Partial<Pick<TerminalInstanceOptions,
  'sessionId' | 'isActive' | 'transport' | 'eventSource' | 'coreConstructor' | 'config'
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
    ...(opts.config ? { config: opts.config } : {}),
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

  it('clears local output and server history through the shared action facade', async () => {
    const { controller, transport } = await mountController();

    controller.actions.clear();
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.clear).toHaveBeenCalledWith('s1');
    expect(transport.sendInput).toHaveBeenCalledWith('s1', '\r');

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

  it('does not initialize while inactive, then attaches when activated', async () => {
    const { controller, transport } = await mountController({ isActive: false, autoRunTimers: false });

    await vi.advanceTimersByTimeAsync(500);
    expect(coreInstances).toHaveLength(0);

    controller.updateOptions({ isActive: true });
    await vi.advanceTimersByTimeAsync(100);
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

  it('cancels delayed initialization when disposed before the mount timer fires', async () => {
    const { controller, events } = await mountController({ autoRunTimers: false });

    controller.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(coreInstances).toHaveLength(0);
    expect(events.getUnsubscribe('s1')).toHaveBeenCalledTimes(1);
  });

  it('surfaces attach failures and retries with the current terminal dimensions', async () => {
    const attach = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const transport = makeTransport({ attach });
    const { controller } = await mountController({ transport, autoRunTimers: false });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

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
