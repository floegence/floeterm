import { describe, expect, it } from 'vitest';
import { TerminalFabricCoordinator } from './TerminalFabricCoordinator';

describe('TerminalFabricCoordinator', () => {
  it('tracks renderer counts, frame timings, and fallback diagnostics', () => {
    const coordinator = new TerminalFabricCoordinator();

    coordinator.setRendererState({
      webgl2Supported: true,
      beamtermLoaded: true,
      backend: 'beamterm_webgl2',
      renderPath: 'main_thread_webgl2',
    });
    coordinator.incrementRendererCounts({ active: 2, visible: 2 });

    const frame = coordinator.beginFrame('write', false, 10);
    coordinator.completeFrame(frame, 8, 320, 14.5);

    expect(coordinator.getDiagnostics()).toMatchObject({
      backend: 'beamterm_webgl2',
      renderPath: 'main_thread_webgl2',
      activeRendererCount: 2,
      visibleViewCount: 2,
      offscreenViewCount: 0,
      frameCount: 1,
      renderedFrameCount: 1,
      lastFrameDurationMs: 4.5,
      lastFrameRenderedRows: 8,
      lastFrameDirtyCells: 320,
      webgl2Supported: true,
      beamtermLoaded: true,
    });

    coordinator.noteFallback(new Error('lost context'));
    expect(coordinator.getDiagnostics()).toMatchObject({
      backend: 'main_thread_canvas_live',
      renderPath: 'canvas_live_fallback',
      fallbackCount: 1,
      lastError: 'lost context',
    });
  });

  it('resets frame stats while preserving live renderer state', () => {
    const coordinator = new TerminalFabricCoordinator();
    coordinator.setRendererState({
      activeRendererCount: 1,
      visibleViewCount: 1,
      backend: 'beamterm_webgl2',
      renderPath: 'main_thread_webgl2',
    });
    const frame = coordinator.beginFrame('external', true, 1);
    coordinator.completeFrame(frame, 2, 20, 3);

    coordinator.resetStats();

    expect(coordinator.getDiagnostics()).toMatchObject({
      backend: 'beamterm_webgl2',
      renderPath: 'main_thread_webgl2',
      activeRendererCount: 1,
      visibleViewCount: 1,
      frameCount: 0,
      renderedFrameCount: 0,
      lastFrameRenderedRows: 0,
      lastFrameDirtyCells: 0,
    });
  });
});
