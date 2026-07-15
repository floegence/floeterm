import { describe, expect, it } from 'vitest';
import {
  TerminalCore,
  TerminalSessionsCoordinator,
  TerminalState,
  createTerminalInstance,
  createTerminalOutputPipeline,
  createPagedTerminalOutputCoordinator,
  getTerminalInitializationSchedulerStats,
  getTerminalRenderSchedulerStats,
  preloadTerminalResources,
  preparePagedTerminalHistory,
  resetTerminalRenderSchedulerStats,
  type AtomicPagedTerminalOutputCoordinatorHandle,
  type PagedTerminalOutputCoordinatorHandle,
  type PreparedPagedTerminalHistory,
  type TerminalAppearance,
  type TerminalDataChunk,
  type TerminalDataEvent,
  type TerminalEventSource,
  type TerminalInstanceController,
  type TerminalLinkProvider,
  type TerminalOutputPipelineChunk,
  type TerminalOutputPipelineDrainState,
  type TerminalOutputPipelineHandle,
  type TerminalOutputPipelineResetOptions,
  type TerminalResponsiveConfig,
  type TerminalRuntimeLineSnapshot,
  type TerminalRestorableSnapshot,
  type TerminalResourceEstimate,
  type TerminalSessionInfo,
  type TerminalTouchScrollRuntime,
  type TerminalTransport,
} from './index';

describe('public framework-neutral API', () => {
  it('keeps low-level and managed terminal routes exported together', () => {
    expect(TerminalCore).toBeTypeOf('function');
    expect(TerminalSessionsCoordinator).toBeTypeOf('function');
    expect(createTerminalInstance).toBeTypeOf('function');
    expect(createTerminalOutputPipeline).toBeTypeOf('function');
    expect(createPagedTerminalOutputCoordinator).toBeTypeOf('function');
    expect(preloadTerminalResources).toBeTypeOf('function');
    expect(preparePagedTerminalHistory).toBeTypeOf('function');
    expect(TerminalState.IDLE).toBe('idle');
    expect(getTerminalInitializationSchedulerStats()).toMatchObject({
      active: expect.any(Number),
      activeBackground: expect.any(Number),
    });
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
    const pipelineChunk: TerminalOutputPipelineChunk = { sequence: 1, data: chunk.data };
    const pipeline: TerminalOutputPipelineHandle = createTerminalOutputPipeline({
      write: () => {},
    });
    const pipelineDrainState: TerminalOutputPipelineDrainState = pipeline.getDrainState();
    const pipelineResetOptions: TerminalOutputPipelineResetOptions = {
      startSequence: 2,
      resumeCatchUp: true,
      allowSequenceSkipOnResume: true,
    };
    const touchScroll: TerminalTouchScrollRuntime = {
      scrollLines: () => true,
      getScrollbackLength: () => 10,
      isAlternateScreen: () => false,
      sendAlternateScreenInput: () => {},
    };
    const restorableSnapshot: TerminalRestorableSnapshot = {
      version: 1,
      data: '\x1bc',
      byteLength: 2,
      partial: false,
      coveredThroughSequence: 1,
      cols: 80,
      rows: 24,
      createdAtMs: 1,
    };
    const resourceEstimate: TerminalResourceEstimate = {
      bufferBytes: 0,
      cellCount: 0,
      estimatedBytes: 0,
      rendererType: 'canvas',
    };
    const preparedHistory: Promise<PreparedPagedTerminalHistory> = preparePagedTerminalHistory({
      fetchPage: async () => ({
        chunks: [pipelineChunk],
        hasMore: false,
        coveredThroughSequence: 1,
        snapshotEndSequence: 1,
        firstRetainedSequence: 1,
        historyGeneration: 1,
      }),
    });

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
    expect(pipelineChunk.sequence).toBe(1);
    expect(pipeline.getStats().pendingChunks).toBe(0);
    expect(pipelineDrainState.drainPending).toBe(false);
    expect(pipelineResetOptions.resumeCatchUp).toBe(true);
    expect(pipelineResetOptions.allowSequenceSkipOnResume).toBe(true);
    expect(touchScroll.scrollLines(1)).toBe(true);
    expect(restorableSnapshot.coveredThroughSequence).toBe(1);
    expect(resourceEstimate.rendererType).toBe('canvas');
    expect(preparedHistory).toBeInstanceOf(Promise);

    pipeline.dispose();
    controller.dispose();
  });

  it('keeps legacy coordinator handle implementations source compatible', () => {
    const snapshot = {
      state: 'idle' as const,
      active: true,
      baselineReady: false,
      coveredThroughSequence: 0,
      retainedLiveChunks: 0,
      retainedLiveBytes: 0,
      retryAttempt: 0,
      retryScheduled: false,
      failure: null,
      lastError: null,
      attachGeneration: 0,
      disposed: false,
    };
    const legacyHandle: PagedTerminalOutputCoordinatorHandle = {
      attach: async () => {},
      waitForBaseline: async () => snapshot,
      pause: async () => snapshot,
      pushLive: () => {},
      setActive: () => {},
      clear: () => {},
      retry: () => {},
      getSnapshot: () => snapshot,
      dispose: () => {},
    };
    const atomicHandle: AtomicPagedTerminalOutputCoordinatorHandle = createPagedTerminalOutputCoordinator({
      fetchPage: async () => ({
        chunks: [],
        hasMore: false,
        coveredThroughSequence: 0,
      }),
      write: () => {},
    });
    const legacyAtomicHandle: AtomicPagedTerminalOutputCoordinatorHandle = {
      ...legacyHandle,
      beginAttach: () => 1,
      completeAttach: async (_generation: number, _snapshotEndSequence?: number) => {},
      attach: async (_startSequence?: number, _snapshotEndSequence?: number) => {},
    };

    expect('beginAttach' in legacyHandle).toBe(false);
    expect(atomicHandle.beginAttach).toBeTypeOf('function');
    expect(legacyAtomicHandle.beginAttach()).toBe(1);
    atomicHandle.dispose();
  });
});
