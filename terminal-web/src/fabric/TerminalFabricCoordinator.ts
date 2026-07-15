import type {
  TerminalFabricBackend,
  TerminalFabricDiagnostics,
  TerminalFabricFrame,
  TerminalFabricFrameReason,
  TerminalFabricRenderPath,
  TerminalFabricStats,
} from './types.js';

const createEmptyStats = (): TerminalFabricStats => ({
  backend: 'main_thread_canvas_live',
  renderPath: 'canvas_live_fallback',
  activeRendererCount: 0,
  visibleViewCount: 0,
  offscreenViewCount: 0,
  frameCount: 0,
  renderedFrameCount: 0,
  lastFrameDurationMs: 0,
  lastFrameRenderedRows: 0,
  lastFrameDirtyCells: 0,
  fullRepaintCount: 0,
  contextRestoreCount: 0,
  fallbackCount: 0,
  workerRestartCount: 0,
  pendingDeltaCount: 0,
  coalescedFrameCount: 0,
});

export class TerminalFabricCoordinator {
  private nextFrameId = 1;
  private stats = createEmptyStats();
  private webgl2Supported = false;
  private beamtermLoaded = false;
  private lastError = '';
  private activeRendererCount = 0;
  private visibleViewCount = 0;
  private offscreenViewCount = 0;

  beginFrame(reason: TerminalFabricFrameReason, forceAll: boolean, now = performance.now()): TerminalFabricFrame {
    const frame = {
      id: this.nextFrameId,
      forceAll,
      reason,
      startedAtMs: now,
    };
    this.nextFrameId += 1;
    this.stats.frameCount += 1;
    if (forceAll) {
      this.stats.fullRepaintCount += 1;
    }
    return frame;
  }

  completeFrame(frame: TerminalFabricFrame, renderedRows: number, dirtyCells: number, now = performance.now()): void {
    this.stats.renderedFrameCount += 1;
    this.stats.lastFrameDurationMs = Math.max(0, now - frame.startedAtMs);
    this.stats.lastFrameRenderedRows = Math.max(0, renderedRows);
    this.stats.lastFrameDirtyCells = Math.max(0, dirtyCells);
  }

  noteCoalescedFrame(): void {
    this.stats.coalescedFrameCount += 1;
  }

  noteFallback(error: unknown): void {
    this.stats.fallbackCount += 1;
    this.stats.backend = 'main_thread_canvas_live';
    this.stats.renderPath = 'canvas_live_fallback';
    this.lastError = error instanceof Error ? error.message : String(error ?? 'unknown fallback');
  }

  noteContextRestore(): void {
    this.stats.contextRestoreCount += 1;
    this.lastError = '';
  }

  noteWorkerRestart(): void {
    this.stats.workerRestartCount += 1;
  }

  setRendererState(next: {
    activeRendererCount?: number;
    visibleViewCount?: number;
    offscreenViewCount?: number;
    pendingDeltaCount?: number;
    webgl2Supported?: boolean;
    beamtermLoaded?: boolean;
    backend?: TerminalFabricBackend;
    renderPath?: TerminalFabricRenderPath;
    lastError?: string;
  }): void {
    if (typeof next.activeRendererCount === 'number') {
      this.activeRendererCount = Math.max(0, next.activeRendererCount);
    }
    if (typeof next.visibleViewCount === 'number') {
      this.visibleViewCount = Math.max(0, next.visibleViewCount);
    }
    if (typeof next.offscreenViewCount === 'number') {
      this.offscreenViewCount = Math.max(0, next.offscreenViewCount);
    }
    this.stats = {
      ...this.stats,
      activeRendererCount: this.activeRendererCount,
      visibleViewCount: this.visibleViewCount,
      offscreenViewCount: this.offscreenViewCount,
      ...(typeof next.pendingDeltaCount === 'number' ? { pendingDeltaCount: next.pendingDeltaCount } : {}),
      ...(next.backend ? { backend: next.backend } : {}),
      ...(next.renderPath ? { renderPath: next.renderPath } : {}),
    };
    if (typeof next.webgl2Supported === 'boolean') {
      this.webgl2Supported = next.webgl2Supported;
    }
    if (typeof next.beamtermLoaded === 'boolean') {
      this.beamtermLoaded = next.beamtermLoaded;
    }
    if (typeof next.lastError === 'string') {
      this.lastError = next.lastError;
    }
  }

  incrementRendererCounts(delta: { active?: number; visible?: number; offscreen?: number }): void {
    this.setRendererState({
      activeRendererCount: this.activeRendererCount + (delta.active ?? 0),
      visibleViewCount: this.visibleViewCount + (delta.visible ?? 0),
      offscreenViewCount: this.offscreenViewCount + (delta.offscreen ?? 0),
    });
  }

  getDiagnostics(): TerminalFabricDiagnostics {
    return {
      ...this.stats,
      webgl2Supported: this.webgl2Supported,
      beamtermLoaded: this.beamtermLoaded,
      lastError: this.lastError,
    };
  }

  resetStats(): void {
    const current = this.stats;
    this.stats = {
      ...createEmptyStats(),
      backend: current.backend,
      renderPath: current.renderPath,
      activeRendererCount: this.activeRendererCount,
      visibleViewCount: this.visibleViewCount,
      offscreenViewCount: this.offscreenViewCount,
      fallbackCount: current.fallbackCount,
      contextRestoreCount: current.contextRestoreCount,
      workerRestartCount: current.workerRestartCount,
    };
  }

  resetAll(): void {
    this.nextFrameId = 1;
    this.stats = createEmptyStats();
    this.webgl2Supported = false;
    this.beamtermLoaded = false;
    this.lastError = '';
    this.activeRendererCount = 0;
    this.visibleViewCount = 0;
    this.offscreenViewCount = 0;
  }
}

export const terminalFabricCoordinator = new TerminalFabricCoordinator();

export const getTerminalFabricDiagnostics = (): TerminalFabricDiagnostics => (
  terminalFabricCoordinator.getDiagnostics()
);

export const resetTerminalFabricDiagnostics = (): void => {
  terminalFabricCoordinator.resetStats();
};
