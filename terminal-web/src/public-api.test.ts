import { describe, expect, it } from 'vitest';
import {
  TerminalCore,
  TerminalSessionsCoordinator,
  TerminalState,
  createTerminalInstance,
  getTerminalRenderSchedulerStats,
  resetTerminalRenderSchedulerStats,
  type TerminalAppearance,
  type TerminalDataChunk,
  type TerminalDataEvent,
  type TerminalEventSource,
  type TerminalInstanceController,
  type TerminalLinkProvider,
  type TerminalResponsiveConfig,
  type TerminalRuntimeLineSnapshot,
  type TerminalSessionInfo,
  type TerminalTouchScrollRuntime,
  type TerminalTransport,
} from './index';

describe('public framework-neutral API', () => {
  it('keeps low-level and managed terminal routes exported together', () => {
    expect(TerminalCore).toBeTypeOf('function');
    expect(TerminalSessionsCoordinator).toBeTypeOf('function');
    expect(createTerminalInstance).toBeTypeOf('function');
    expect(TerminalState.IDLE).toBe('idle');
    expect(getTerminalRenderSchedulerStats()).toEqual(expect.objectContaining({ scheduled: expect.any(Number) }));
    resetTerminalRenderSchedulerStats();
  });

  it('compiles the downstream integration surface without any UI framework types', () => {
    const chunk: TerminalDataChunk = {
      sequence: 1,
      data: new Uint8Array([65]),
      timestampMs: 1,
    };
    const event: TerminalDataEvent = {
      sessionId: 's1',
      type: 'data',
      data: chunk.data,
      sequence: chunk.sequence,
      timestampMs: chunk.timestampMs,
    };
    const session: TerminalSessionInfo = {
      id: 's1',
      name: 'shell',
      workingDir: '/',
      createdAtMs: 1,
      lastActiveAtMs: 1,
      isActive: true,
    };
    const transport: TerminalTransport = {
      attach: async () => {},
      resize: async () => {},
      sendInput: async () => {},
      history: async () => [chunk],
      clear: async () => {},
      listSessions: async () => [session],
    };
    const eventSource: TerminalEventSource = {
      onTerminalData: (_sessionId, handler) => {
        handler(event);
        return () => {};
      },
    };
    const linkProvider: TerminalLinkProvider = {
      provideLinks: (_row, callback) => callback([]),
    };
    const appearance: TerminalAppearance = { fontSize: 13, presentationScale: 1 };
    const responsive: TerminalResponsiveConfig = { fitOnFocus: true, notifyResizeOnlyWhenFocused: true };
    const line: TerminalRuntimeLineSnapshot = { row: 0, text: 'demo' };
    const touchScroll: TerminalTouchScrollRuntime = {
      scrollLines: () => true,
      getScrollbackLength: () => 10,
      isAlternateScreen: () => false,
      sendAlternateScreenInput: () => {},
    };

    const controller: TerminalInstanceController = createTerminalInstance({
      sessionId: session.id,
      isActive: false,
      transport,
      eventSource,
      config: { responsive },
    });

    expect(controller.getSnapshot().state.state).toBe(TerminalState.IDLE);
    expect(linkProvider).toBeDefined();
    expect(appearance.fontSize).toBe(13);
    expect(line.text).toBe('demo');
    expect(touchScroll.scrollLines(1)).toBe(true);

    controller.dispose();
  });
});
