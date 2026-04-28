import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useTerminalInstance } from './useTerminalInstance';
import type {
  TerminalCoreLike,
  TerminalDataEvent,
  TerminalDataSubscriptionOptions,
  TerminalEventSource,
  TerminalTransport
} from '../types';
import { TerminalState } from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const flushPromises = async (): Promise<void> => {
  // Advance microtasks scheduled by async hooks/state updates.
  await Promise.resolve();
};

type FakeHandlers = {
  onData?: (data: string) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
  onStateChange?: (state: TerminalState) => void;
  onError?: (error: Error) => void;
};

class FakeTerminalCore implements TerminalCoreLike {
  static instances: FakeTerminalCore[] = [];
  static nextDimensions = { cols: 80, rows: 24 };

  private state: TerminalState = TerminalState.IDLE;
  private dimensions = { ...FakeTerminalCore.nextDimensions };

  readonly writes: string[] = [];
  readonly historyReplayDurations: number[] = [];
  endHistoryReplayCalls = 0;
  clearCalls = 0;
  focusCalls = 0;
  connected = false;

  constructor(
    _container: HTMLElement,
    _config = {},
    private handlers: FakeHandlers = {}
  ) {
    FakeTerminalCore.instances.push(this);
  }

  static reset(): void {
    FakeTerminalCore.instances = [];
    FakeTerminalCore.nextDimensions = { cols: 80, rows: 24 };
  }

  async initialize(): Promise<void> {
    this.state = TerminalState.READY;
    this.handlers.onStateChange?.(TerminalState.READY);
  }

  dispose(): void {
    this.state = TerminalState.DISPOSED;
    this.handlers.onStateChange?.(TerminalState.DISPOSED);
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes.push(typeof data === 'string' ? data : decoder.decode(data));
    callback?.();
  }

  clear(): void {
    this.clearCalls += 1;
  }

  serialize(): string {
    return this.writes.join('');
  }

  getSelectionText(): string {
    return '';
  }

  hasSelection(): boolean {
    return false;
  }

  async copySelection() {
    return { copied: false as const, reason: 'empty_selection' as const, source: 'command' as const };
  }

  getState(): TerminalState {
    return this.state;
  }

  getDimensions(): { cols: number; rows: number } {
    return this.dimensions;
  }

  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null {
    return { rows: this.dimensions.rows, cols: this.dimensions.cols, bufferLength: this.writes.length };
  }

  findNext(): boolean {
    return false;
  }

  findPrevious(): boolean {
    return false;
  }

  clearSearch(): void {}
  setSearchResultsCallback(): void {}

  focus(): void {
    this.focusCalls += 1;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  forceResize(): void {
    this.handlers.onResize?.(this.dimensions);
  }

  setTheme(): void {}
  setFontSize(): void {}
  setPresentationScale(): void {}

  startHistoryReplay(duration?: number): void {
    this.historyReplayDurations.push(duration ?? 0);
  }

  endHistoryReplay(): void {
    this.endHistoryReplayCalls += 1;
  }

  emitInput(data: string): void {
    this.handlers.onData?.(data);
  }

  emitResize(size: { cols: number; rows: number }): void {
    this.dimensions = size;
    this.handlers.onResize?.(size);
  }
}

type SubscriptionRecord = {
  sessionId: string;
  handler: (event: TerminalDataEvent) => void;
  options?: TerminalDataSubscriptionOptions;
};

const createEventSourceHarness = () => {
  const subscriptions: SubscriptionRecord[] = [];
  const handlersBySession = new Map<string, (event: TerminalDataEvent) => void>();

  const eventSource: TerminalEventSource = {
    onTerminalData: (sessionId, handler, options) => {
      subscriptions.push({ sessionId, handler, options });
      handlersBySession.set(sessionId, handler);
      return () => {
        if (handlersBySession.get(sessionId) === handler) {
          handlersBySession.delete(sessionId);
        }
      };
    }
  };

  const emit = (
    sessionId: string,
    sequence: number,
    payload: string,
    type: TerminalDataEvent['type'] = 'data'
  ) => {
    const handler = handlersBySession.get(sessionId);
    if (!handler) {
      throw new Error(`No handler registered for ${sessionId}`);
    }

    handler({
      sessionId,
      type,
      sequence,
      data: type === 'replay-complete' ? new Uint8Array(0) : encoder.encode(payload),
      timestampMs: Date.now()
    });
  };

  return { eventSource, subscriptions, emit };
};

const createTransport = (): TerminalTransport => ({
  attach: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  history: vi.fn().mockResolvedValue([]),
  clear: vi.fn().mockResolvedValue(undefined)
});

const mountHarness = async (options?: {
  sessionId?: string;
  isActive?: boolean;
  autoFocus?: boolean;
  eventSource?: TerminalEventSource;
  transport?: TerminalTransport;
  onResize?: (cols: number, rows: number) => void;
}) => {
  const eventHarness = createEventSourceHarness();
  const eventSource = options?.eventSource ?? eventHarness.eventSource;
  const transport = options?.transport ?? createTransport();
  let latestActions: ReturnType<typeof useTerminalInstance>['actions'] | null = null;
  let latestState: ReturnType<typeof useTerminalInstance>['state'] | null = null;
  let latestLoadingState = '';

  const Harness = (props: { sessionId: string; isActive: boolean; eventSource: TerminalEventSource }) => {
    const { containerRef, actions, state, loadingState } = useTerminalInstance({
      sessionId: props.sessionId,
      isActive: props.isActive,
      autoFocus: options?.autoFocus,
      transport,
      eventSource: props.eventSource,
      onResize: options?.onResize,
      coreConstructor: FakeTerminalCore as any
    });

    latestActions = actions;
    latestState = state;
    latestLoadingState = loadingState;
    return React.createElement('div', { ref: containerRef });
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        sessionId: options?.sessionId ?? 'A',
        isActive: options?.isActive ?? true,
        eventSource
      }),
      { createNodeMock: () => ({}) }
    );
    await flushPromises();
  });

  await act(async () => {
    vi.advanceTimersByTime(200);
    await flushPromises();
    vi.runOnlyPendingTimers();
    await flushPromises();
  });

  return {
    renderer,
    transport,
    eventHarness,
    get actions() {
      if (!latestActions) {
        throw new Error('actions not ready');
      }
      return latestActions;
    },
    get state() {
      if (!latestState) {
        throw new Error('state not ready');
      }
      return latestState;
    },
    get loadingState() {
      return latestLoadingState;
    },
    update: async (props: { sessionId?: string; isActive?: boolean; eventSource?: TerminalEventSource }) => {
      await act(async () => {
        renderer.update(React.createElement(Harness, {
          sessionId: props.sessionId ?? options?.sessionId ?? 'A',
          isActive: props.isActive ?? options?.isActive ?? true,
          eventSource: props.eventSource ?? eventSource
        }));
        vi.runOnlyPendingTimers();
        await flushPromises();
      });
    }
  };
};

describe('useTerminalInstance', () => {
  beforeAll(() => {
    // The hook uses requestAnimationFrame to schedule terminal writes. In the node
    // test environment, provide a minimal polyfill backed by setTimeout.
    if (!globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
        return setTimeout(() => cb(Date.now()), 0) as unknown as number;
      };
    }
    if (!globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame = (id: number): void => {
        clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
      };
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    FakeTerminalCore.reset();
  });

  it('resets sequence ordering when sessionId changes before coalescing the frame write', async () => {
    vi.useFakeTimers();
    const mounted = await mountHarness();

    await act(async () => {
      mounted.eventHarness.emit('A', 1, 'A1');
      mounted.eventHarness.emit('A', 2, 'A2');
      vi.runAllTimers();
      await flushPromises();
    });

    const firstCore = FakeTerminalCore.instances[0];
    expect(firstCore.writes).toEqual(['A1A2']);

    await mounted.update({ sessionId: 'B' });
    firstCore.writes.length = 0;

    await act(async () => {
      mounted.eventHarness.emit('B', 2, 'B2');
      mounted.eventHarness.emit('B', 1, 'B1');
      vi.runAllTimers();
      await flushPromises();
    });

    expect(firstCore.writes).toEqual(['B1B2']);
  });

  it('splits display writes at the chunk batch limit without dropping data', async () => {
    vi.useFakeTimers();
    const mounted = await mountHarness();
    const core = FakeTerminalCore.instances[0];

    await act(async () => {
      for (let seq = 1; seq <= 65; seq += 1) {
        mounted.eventHarness.emit('A', seq, 'x');
      }
      vi.runOnlyPendingTimers();
      await flushPromises();
    });

    expect(core.writes).toEqual(['x'.repeat(64)]);

    await act(async () => {
      vi.runAllTimers();
      await flushPromises();
    });

    expect(core.writes).toEqual(['x'.repeat(64), 'x']);
  });

  it('flushes pending replay gaps on replay-complete and ends history replay', async () => {
    vi.useFakeTimers();
    const mounted = await mountHarness({ autoFocus: true });
    const core = FakeTerminalCore.instances[0];

    await act(async () => {
      mounted.eventHarness.emit('A', 2, 'late');
      vi.runOnlyPendingTimers();
      await flushPromises();
    });
    expect(core.writes).toEqual([]);
    expect(mounted.loadingState).toBe('processing_history');

    await act(async () => {
      mounted.eventHarness.emit('A', 2, '', 'replay-complete');
      vi.runOnlyPendingTimers();
      await flushPromises();
    });

    expect(core.writes).toEqual(['late']);
    expect(core.endHistoryReplayCalls).toBe(1);
    expect(mounted.loadingState).toBe('ready');

  });

  it('resubscribes with the last applied sequence when the event source changes', async () => {
    vi.useFakeTimers();
    const first = createEventSourceHarness();
    const mounted = await mountHarness({ eventSource: first.eventSource });

    await act(async () => {
      first.emit('A', 1, 'one');
      first.emit('A', 2, 'two');
      first.emit('A', 2, '', 'replay-complete');
      vi.runAllTimers();
      await flushPromises();
    });

    expect(FakeTerminalCore.instances[0].writes).toEqual(['onetwo']);

    const second = createEventSourceHarness();
    await mounted.update({ eventSource: second.eventSource });

    expect(second.subscriptions).toHaveLength(1);
    expect(second.subscriptions[0].options?.lastSeq).toBe(2);
  });

  it('uses terminal dimensions for attach, forwards resize once, and avoids resize-triggered reattach', async () => {
    vi.useFakeTimers();
    FakeTerminalCore.nextDimensions = { cols: 100, rows: 30 };
    const onResize = vi.fn();
    const mounted = await mountHarness({ onResize });
    const transport = mounted.transport;
    const core = FakeTerminalCore.instances[0];

    expect(transport.resize).toHaveBeenCalledWith('A', 100, 30);
    expect(transport.attach).toHaveBeenCalledWith('A', 100, 30);
    expect(transport.attach).toHaveBeenCalledTimes(1);
    expect(mounted.state.dimensions).toEqual({ cols: 80, rows: 24 });

    await act(async () => {
      core.emitResize({ cols: 120, rows: 40 });
      await flushPromises();
      vi.runOnlyPendingTimers();
      await flushPromises();
    });

    expect(onResize).toHaveBeenCalledWith(120, 40);
    expect(transport.resize).toHaveBeenLastCalledWith('A', 120, 40);
    expect(transport.attach).toHaveBeenCalledTimes(1);
    expect(mounted.state.dimensions).toEqual({ cols: 120, rows: 40 });
  });

  it('forwards terminal input and action input to the transport', async () => {
    vi.useFakeTimers();
    const mounted = await mountHarness();
    const core = FakeTerminalCore.instances[0];

    await act(async () => {
      core.emitInput('typed\r');
      mounted.actions.sendInput('manual\r');
      await flushPromises();
    });

    expect(mounted.transport.sendInput).toHaveBeenCalledWith('A', 'typed\r');
    expect(mounted.transport.sendInput).toHaveBeenCalledWith('A', 'manual\r');
  });

  it('clears history and redraws prompt on clear', async () => {
    vi.useFakeTimers();
    const mounted = await mountHarness();
    const core = FakeTerminalCore.instances[0];

    await act(async () => {
      mounted.actions.clear();
      await flushPromises();
    });

    expect(core.clearCalls).toBe(1);
    expect(mounted.transport.clear).toHaveBeenCalledWith('A');
    expect(mounted.transport.sendInput).toHaveBeenCalledWith('A', '\r');
  });
});
