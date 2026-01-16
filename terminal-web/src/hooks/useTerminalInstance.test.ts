import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useTerminalInstance } from './useTerminalInstance';
import type { TerminalCoreLike, TerminalDataEvent, TerminalEventSource, TerminalTransport } from '../types';
import { TerminalState } from '../types';

const flushPromises = async (): Promise<void> => {
  // Advance microtasks scheduled by async hooks/state updates.
  await Promise.resolve();
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resets sequence ordering when sessionId changes', async () => {
    vi.useFakeTimers();

    const writes: string[] = [];

    class FakeTerminalCore implements TerminalCoreLike {
      private state: TerminalState = TerminalState.IDLE;

      constructor(
        _container: HTMLElement,
        _config = {},
        private handlers: Record<string, unknown> = {}
      ) {}

      async initialize(): Promise<void> {
        this.state = TerminalState.READY;
        (this.handlers as any).onStateChange?.(TerminalState.READY);
      }

      dispose(): void {
        this.state = TerminalState.DISPOSED;
        (this.handlers as any).onStateChange?.(TerminalState.DISPOSED);
      }

      write(data: string | Uint8Array, callback?: () => void): void {
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        writes.push(text);
        callback?.();
      }

      clear(): void {}
      serialize(): string {
        return '';
      }
      getSelectionText(): string {
        return '';
      }
      getState(): TerminalState {
        return this.state;
      }
      getDimensions(): { cols: number; rows: number } {
        return { cols: 80, rows: 24 };
      }
      getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null {
        return null;
      }
      findNext(): boolean {
        return false;
      }
      findPrevious(): boolean {
        return false;
      }
      clearSearch(): void {}
      setSearchResultsCallback(): void {}
      focus(): void {}
      setConnected(): void {}
      forceResize(): void {}
      setTheme(): void {}
      setFontSize(): void {}
      startHistoryReplay(): void {}
    }

    const handlersBySession = new Map<string, (event: TerminalDataEvent) => void>();
    const eventSource: TerminalEventSource = {
      onTerminalData: (sessionId, handler) => {
        handlersBySession.set(sessionId, handler);
        return () => {
          handlersBySession.delete(sessionId);
        };
      }
    };

    const transport: TerminalTransport = {
      attach: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      sendInput: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue(undefined)
    };

    const emit = (sessionId: string, sequence: number, payload: string) => {
      const handler = handlersBySession.get(sessionId);
      if (!handler) {
        throw new Error(`No handler registered for ${sessionId}`);
      }
      const event: TerminalDataEvent = {
        sessionId,
        sequence,
        data: new TextEncoder().encode(payload),
        timestampMs: Date.now()
      };
      handler(event);
    };

    const Harness = (props: { sessionId: string }) => {
      const { containerRef } = useTerminalInstance({
        sessionId: props.sessionId,
        isActive: true,
        transport,
        eventSource,
        coreConstructor: FakeTerminalCore as any
      });

      return React.createElement('div', { ref: containerRef });
    };

    const renderer = TestRenderer.create(React.createElement(Harness, { sessionId: 'A' }), {
      createNodeMock: () => ({})
    });

    // Allow the hook to initialize.
    await act(async () => {
      vi.advanceTimersByTime(200);
      await flushPromises();
      vi.runOnlyPendingTimers();
      await flushPromises();
    });

    // Prime the sequence buffer for session A.
    await act(async () => {
      emit('A', 1, 'A1');
      emit('A', 2, 'A2');
      vi.runAllTimers();
      await flushPromises();
    });

    writes.length = 0;

    // Switch to session B and emit out-of-order chunks. After the reset, the hook
    // should reorder them so writes happen as B1 then B2.
    await act(async () => {
      renderer.update(React.createElement(Harness, { sessionId: 'B' }));
      vi.runAllTimers();
      await flushPromises();
    });

    await act(async () => {
      emit('B', 2, 'B2');
      emit('B', 1, 'B1');
      vi.runAllTimers();
      await flushPromises();
    });

    expect(writes).toEqual(['B1', 'B2']);
  });
});
