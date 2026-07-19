import type { Logger } from '../types.js';
import { BeamtermFabricRenderer } from './BeamtermFabricRenderer.js';
import {
  getTerminalFabricDiagnostics,
  terminalFabricCoordinator,
} from './TerminalFabricCoordinator.js';
import type {
  TerminalFabricCursor,
  TerminalFabricDiagnostics,
  TerminalFabricFrameReason,
  TerminalFabricRenderer,
  TerminalFabricRowRenderHints,
  TerminalFabricTheme,
} from './types.js';
export type { TerminalFabricRowRenderHints } from './types.js';

type TerminalLiveFabricSession = {
  sessionId: string;
  refCount: number;
};

type TerminalLiveFabricView = {
  viewId: string;
  sessionId: string;
  renderer: TerminalFabricRenderer;
};

export type TerminalLiveFabricRendererFactory = (request: {
  viewId: string;
}) => TerminalFabricRenderer;

export type TerminalLiveFabricAttachRequest = {
  sessionId: string;
  viewId: string;
  container: HTMLElement;
  logger: Logger;
  fontFamily: string;
  fontSize: number;
  theme: Record<string, string>;
  getGhosttyCanvas: () => HTMLCanvasElement | null;
  focusInputSurface: () => void;
  forwardWheel: (event: WheelEvent) => void;
  onRendererError?: (error: Error) => void;
};

export type TerminalLiveFabricOptions = {
  createRenderer?: TerminalLiveFabricRendererFactory;
};

export type TerminalLiveFabricViewHandle = {
  viewId: string;
  sessionId: string;
  renderer: TerminalFabricRenderer;
  dispose(): void;
};

export class TerminalLiveFabric {
  private readonly sessions = new Map<string, TerminalLiveFabricSession>();
  private readonly views = new Map<string, TerminalLiveFabricView>();
  private readonly createRenderer: TerminalLiveFabricRendererFactory;

  constructor(options: TerminalLiveFabricOptions = {}) {
    this.createRenderer = options.createRenderer ?? defaultRendererFactory;
  }

  async attachView(request: TerminalLiveFabricAttachRequest): Promise<TerminalLiveFabricViewHandle> {
    const session = this.sessions.get(request.sessionId) ?? {
      sessionId: request.sessionId,
      refCount: 0,
    };
    session.refCount += 1;
    this.sessions.set(session.sessionId, session);

    const renderer = this.createRenderer({ viewId: request.viewId });
    try {
      await renderer.initialize({
        container: request.container,
        logger: request.logger,
        fontFamily: request.fontFamily,
        fontSize: request.fontSize,
        theme: request.theme,
        getGhosttyCanvas: request.getGhosttyCanvas,
        focusInputSurface: request.focusInputSurface,
        forwardWheel: request.forwardWheel,
        onRendererError: request.onRendererError ?? (() => undefined),
      });
    } catch (error) {
      this.releaseSession(session.sessionId);
      terminalFabricCoordinator.noteRendererError(error);
      request.logger.error('[TerminalLiveFabric] Beamterm renderer initialization failed', { error });
      throw error;
    }

    const view = {
      viewId: request.viewId,
      sessionId: request.sessionId,
      renderer,
    };
    this.views.set(view.viewId, view);

    return {
      viewId: view.viewId,
      sessionId: view.sessionId,
      renderer,
      dispose: () => {
        this.detachView(view.viewId);
      },
    };
  }

  detachView(viewId: string): void {
    const view = this.views.get(viewId);
    if (!view) {
      return;
    }
    this.views.delete(viewId);
    view.renderer.dispose();
    this.releaseSession(view.sessionId);
  }

  private releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.refCount -= 1;
    if (session.refCount <= 0) {
      this.sessions.delete(session.sessionId);
    }
  }

  getDiagnostics(): TerminalFabricDiagnostics {
    return getTerminalFabricDiagnostics();
  }

  dispose(): void {
    for (const viewId of Array.from(this.views.keys())) {
      this.detachView(viewId);
    }
    this.sessions.clear();
  }
}

export const terminalLiveFabric = new TerminalLiveFabric();

function defaultRendererFactory({ viewId }: {
  viewId: string;
}): TerminalFabricRenderer {
  void viewId;
  return new BeamtermFabricRenderer();
}

export const themeToFabricTheme = (theme: Record<string, string>): TerminalFabricTheme => ({
  background: parseThemeColor(theme.background, 0x000000),
  foreground: parseThemeColor(theme.foreground, 0xffffff),
});

export const cursorToFabricCursor = (value: unknown): TerminalFabricCursor | null => {
  const raw = value as Partial<TerminalFabricCursor> | null | undefined;
  if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') {
    return null;
  }
  return {
    x: raw.x,
    y: raw.y,
    visible: raw.visible !== false,
  };
};

export const renderReasonFromForce = (forceAll: boolean): TerminalFabricFrameReason => (
  forceAll ? 'external' : 'write'
);

const parseThemeColor = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('');
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  const longHex = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (longHex) {
    return Number.parseInt(longHex[1], 16);
  }
  return fallback;
};
