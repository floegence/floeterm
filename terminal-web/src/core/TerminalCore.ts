import { filterXtermAutoResponses } from '../utils/xtermAutoResponseFilter';
import { createConsoleLogger, noopLogger } from '../utils/logger';
import { TerminalState, type Logger, type TerminalConfig, type TerminalEventHandlers } from '../types';

// Dynamic imports avoid SSR issues and keep the bundle flexible.
let TerminalCtor: typeof import('ghostty-web').Terminal | null = null;
let FitAddonCtor: typeof import('ghostty-web').FitAddon | null = null;
let ghosttyInit: typeof import('ghostty-web').init | null = null;
let ghosttyInitPromise: Promise<void> | null = null;

const loadGhosttyModules = async (logger: Logger): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('ghostty-web 只能在浏览器环境中加载');
  }

  if (TerminalCtor && FitAddonCtor && ghosttyInit) {
    return;
  }

  const { Terminal, FitAddon, init } = await import('ghostty-web');
  TerminalCtor = Terminal;
  FitAddonCtor = FitAddon;
  ghosttyInit = init;

  if (!ghosttyInitPromise) {
    logger.debug('[TerminalCore] Initializing ghostty-web WASM');
    ghosttyInitPromise = init().catch(error => {
      ghosttyInitPromise = null;
      throw error;
    });
  }

  await ghosttyInitPromise;
};

const mapThemeToGhostty = (theme: Record<string, unknown> | undefined): Record<string, string> => {
  if (!theme) {
    return {};
  }

  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === 'string') {
      mapped[key] = value;
    }
  }

  if (mapped.selection && !mapped.selectionBackground) {
    mapped.selectionBackground = mapped.selection;
    delete mapped.selection;
  }

  return mapped;
};

// TerminalCore provides a focused wrapper around ghostty-web (xterm.js API-compatible) and its fit addon.
export class TerminalCore {
  private terminal: import('ghostty-web').Terminal | null = null;
  private fitAddon: import('ghostty-web').FitAddon | null = null;
  private needsFullRenderOnNextWrite = false;

  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private state: TerminalState = TerminalState.IDLE;
  private isDisposed = false;

  private isReplayingHistory = false;
  private replayingHistoryTimer: ReturnType<typeof setTimeout> | null = null;

  private logger: Logger;
  private eventHandlers: TerminalEventHandlers;

  constructor(
    private container: HTMLElement,
    private config: TerminalConfig = {},
    eventHandlers: TerminalEventHandlers = {},
    logger: Logger = createConsoleLogger()
  ) {
    this.eventHandlers = eventHandlers;
    this.logger = logger ?? noopLogger;
  }

  // initialize creates the ghostty-web terminal instance and binds addons.
  async initialize(): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Cannot initialize a disposed TerminalCore');
    }

    if (this.terminal || this.state === TerminalState.INITIALIZING) {
      return;
    }

    this.setState(TerminalState.INITIALIZING);
    await loadGhosttyModules(this.logger);
    await this.createTerminalInstance();
    await this.loadAddons();
    await this.openTerminal();
    this.setupEventListeners();
    this.startSizeWatching();

    this.setState(TerminalState.READY);

    setTimeout(() => {
      if (this.isReady() && this.fitAddon) {
        try {
          this.fitAddon.fit();
        } catch (error) {
          this.logger.debug('[TerminalCore] Post-initialization fit failed', { error });
        }
      }
    }, 100);
  }

  private async createTerminalInstance(): Promise<void> {
    if (!TerminalCtor) {
      throw new Error('ghostty-web module not loaded');
    }

    const defaultConfig: TerminalConfig = {
      cols: 80,
      rows: 24,
      theme: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        cursor: '#ffffff',
        selectionBackground: '#ffffff40'
      },
      fontSize: 12,
      fontFamily: '\"SF Mono\", Monaco, \"Cascadia Code\", \"Roboto Mono\", Consolas, \"Courier New\", monospace',
      cursorBlink: true,
      scrollback: 1000,
      allowTransparency: false,
      convertEol: true,
      cursorStyle: 'block',
      disableStdin: false,
      smoothScrollDuration: 80
    };

    const finalConfig = { ...defaultConfig, ...this.config };
    this.terminal = new TerminalCtor({
      cols: typeof finalConfig.cols === 'number' ? finalConfig.cols : undefined,
      rows: typeof finalConfig.rows === 'number' ? finalConfig.rows : undefined,
      cursorBlink: typeof finalConfig.cursorBlink === 'boolean' ? finalConfig.cursorBlink : undefined,
      cursorStyle: typeof (finalConfig as any).cursorStyle === 'string' ? ((finalConfig as any).cursorStyle as any) : undefined,
      theme: mapThemeToGhostty(finalConfig.theme),
      scrollback: typeof finalConfig.scrollback === 'number' ? finalConfig.scrollback : undefined,
      fontSize: typeof finalConfig.fontSize === 'number' ? finalConfig.fontSize : undefined,
      fontFamily: typeof finalConfig.fontFamily === 'string' ? finalConfig.fontFamily : undefined,
      allowTransparency: typeof finalConfig.allowTransparency === 'boolean' ? finalConfig.allowTransparency : undefined,
      convertEol: typeof finalConfig.convertEol === 'boolean' ? finalConfig.convertEol : undefined,
      disableStdin: typeof (finalConfig as any).disableStdin === 'boolean' ? ((finalConfig as any).disableStdin as boolean) : undefined,
      smoothScrollDuration: typeof (finalConfig as any).smoothScrollDuration === 'number' ? ((finalConfig as any).smoothScrollDuration as number) : undefined
    });
  }

  private async loadAddons(): Promise<void> {
    if (!this.terminal) {
      throw new Error('Terminal instance not created');
    }

    if (!FitAddonCtor) {
      throw new Error('Required ghostty-web addons not loaded');
    }

    this.fitAddon = new FitAddonCtor();
    this.terminal.loadAddon(this.fitAddon);
  }

  private async openTerminal(): Promise<void> {
    if (!this.terminal) {
      throw new Error('Terminal instance not created');
    }

    await this.waitForDOMAndFonts();
    await this.ensureContainerReady();
    this.terminal.open(this.container);
  }

  private async waitForDOMAndFonts(): Promise<void> {
    if (document.readyState !== 'complete') {
      await new Promise<void>((resolve) => {
        const handler = () => {
          if (document.readyState === 'complete') {
            document.removeEventListener('readystatechange', handler);
            resolve();
          }
        };
        document.addEventListener('readystatechange', handler);
      });
    }

    if (typeof document.fonts !== 'undefined' && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (error) {
        this.logger.warn('[TerminalCore] Font loading failed, continuing', { error });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private async ensureContainerReady(): Promise<void> {
    const maxRetries = 15;
    const retryDelay = 50;

    if (!document.contains(this.container)) {
      throw new Error('Container element is no longer in the DOM');
    }

    for (let i = 0; i < maxRetries; i += 1) {
      if (!document.contains(this.container)) {
        throw new Error('Container element removed from DOM during initialization');
      }

      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      const style = getComputedStyle(this.container);

      if (width > 0 && height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
        return;
      }

      await new Promise(resolve => requestAnimationFrame(resolve));
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  private setupEventListeners(): void {
    if (!this.terminal) {
      return;
    }

    if (this.eventHandlers.onData) {
      this.terminal.onData((data: string) => {
        let filtered = data;
        if (this.isReplayingHistory) {
          filtered = filterXtermAutoResponses(data);
          if (filtered.length === 0) {
            return;
          }
        }
        this.eventHandlers.onData?.(filtered);
      });
    }

    if (this.eventHandlers.onResize) {
      this.terminal.onResize(this.eventHandlers.onResize);
    }
  }

  private startSizeWatching(): void {
    if (!this.container || !this.fitAddon) {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.debouncedResize();
    });

    this.resizeObserver.observe(this.container);
  }

  private debouncedResize(): void {
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
    }

    this.resizeDebounceTimer = setTimeout(() => {
      this.performResize();
    }, 16);
  }

  private performResize(): void {
    if (!this.isReady() || !this.fitAddon || !this.terminal) {
      return;
    }

    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) {
      return;
    }

    try {
      this.fitAddon.fit();
    } catch (error) {
      this.logger.debug('[TerminalCore] Resize failed', { error });
    }
  }

  private setState(newState: TerminalState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.eventHandlers.onStateChange?.(newState);
    }
  }

  private isReady(): boolean {
    return this.state === TerminalState.READY || this.state === TerminalState.CONNECTED;
  }

  // startHistoryReplay enables auto-response filtering for a limited duration.
  startHistoryReplay(duration = 2000): void {
    if (this.replayingHistoryTimer) {
      clearTimeout(this.replayingHistoryTimer);
    }
    this.isReplayingHistory = true;
    this.replayingHistoryTimer = setTimeout(() => this.endHistoryReplay(), duration);
  }

  // endHistoryReplay disables auto-response filtering.
  endHistoryReplay(): void {
    if (this.replayingHistoryTimer) {
      clearTimeout(this.replayingHistoryTimer);
      this.replayingHistoryTimer = null;
    }
    this.isReplayingHistory = false;
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (!this.terminal || !this.isReady()) {
      callback?.();
      return;
    }

    try {
      const shouldForce = this.needsFullRenderOnNextWrite;

      if (callback || shouldForce) {
        this.terminal.write(data as string | Uint8Array, () => {
          if (shouldForce) {
            this.needsFullRenderOnNextWrite = false;
            this.forceFullRender();
          }
          callback?.();
        });
        return;
      }

      this.terminal.write(data as string | Uint8Array);
    } catch (error) {
      this.logger.error('[TerminalCore] Write failed', { error });
      callback?.();
    }
  }

  clear(): void {
    if (!this.terminal || !this.isReady()) {
      return;
    }

    this.terminal.clear();
    this.needsFullRenderOnNextWrite = true;
    this.forceFullRender();
  }

  serialize(): string {
    return '';
  }

  getSelectionText(): string {
    if (!this.terminal) {
      return '';
    }
    return this.terminal.getSelection();
  }

  getState(): TerminalState {
    return this.state;
  }

  getDimensions(): { cols: number; rows: number } {
    if (!this.terminal) {
      return { cols: 0, rows: 0 };
    }
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  getTerminalInfo(): { rows: number; cols: number; bufferLength: number } | null {
    if (!this.terminal) {
      return null;
    }
    return {
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      bufferLength: this.terminal.buffer.active.length
    };
  }

  findNext(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    void term;
    void options;
    return false;
  }

  findPrevious(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    void term;
    void options;
    return false;
  }

  clearSearch(): void {
  }

  setSearchResultsCallback(callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null): void {
    void callback;
  }

  focus(): void {
    this.terminal?.focus();
  }

  setConnected(isConnected: boolean): void {
    this.setState(isConnected ? TerminalState.CONNECTED : TerminalState.READY);
  }

  forceResize(): void {
    this.performResize();
    this.forceFullRender();
  }

  setTheme(theme: Record<string, string>): void {
    if (!this.terminal) {
      return;
    }

    const mapped = mapThemeToGhostty(theme);
    this.terminal.options.theme = mapped;

    const terminalAny = this.terminal as unknown as {
      renderer?: { setTheme?: (theme: Record<string, string>) => void; render?: (...args: unknown[]) => void };
      wasmTerm?: unknown;
      viewportY?: number;
      scrollbarOpacity?: number;
    };

    if (terminalAny.renderer?.setTheme) {
      terminalAny.renderer.setTheme(mapped);
    }

    if (terminalAny.renderer?.render && terminalAny.wasmTerm) {
      try {
        terminalAny.renderer.render(
          terminalAny.wasmTerm,
          true,
          terminalAny.viewportY ?? 0,
          terminalAny,
          terminalAny.scrollbarOpacity
        );
      } catch (error) {
        this.logger.debug('[TerminalCore] Theme render failed', { error });
      }
    }
  }

  setFontSize(size: number): void {
    if (!this.terminal) {
      return;
    }
    this.terminal.options.fontSize = size;
    this.fitAddon?.fit();
  }

  dispose(): void {
    this.isDisposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeDebounceTimer) {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    if (this.replayingHistoryTimer) {
      clearTimeout(this.replayingHistoryTimer);
      this.replayingHistoryTimer = null;
    }
    this.terminal?.dispose();
    this.terminal = null;
    this.setState(TerminalState.DISPOSED);
  }

  private forceFullRender(): void {
    if (!this.terminal || !this.isReady()) {
      return;
    }

    const terminalAny = this.terminal as unknown as {
      renderer?: { render?: (...args: unknown[]) => void };
      wasmTerm?: unknown;
      viewportY?: number;
      scrollbarOpacity?: number;
    };

    if (!terminalAny.renderer?.render || !terminalAny.wasmTerm) {
      return;
    }

    try {
      terminalAny.renderer.render(
        terminalAny.wasmTerm,
        true,
        terminalAny.viewportY ?? 0,
        terminalAny,
        terminalAny.scrollbarOpacity
      );
    } catch (error) {
      this.logger.debug('[TerminalCore] Force render failed', { error });
    }
  }
}
