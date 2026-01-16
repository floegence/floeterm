import '../styles/search-highlight.css';
import { filterXtermAutoResponses } from '../utils/xtermAutoResponseFilter';
import { createConsoleLogger, noopLogger } from '../utils/logger';
import { TerminalState, type Logger, type TerminalConfig, type TerminalEventHandlers } from '../types';

// Dynamic imports avoid SSR issues and keep the bundle flexible.
let TerminalCtor: typeof import('@xterm/xterm').Terminal | null = null;
let FitAddonCtor: typeof import('@xterm/addon-fit').FitAddon | null = null;
let SearchAddonCtor: typeof import('@xterm/addon-search').SearchAddon | null = null;
let WebLinksAddonCtor: typeof import('@xterm/addon-web-links').WebLinksAddon | null = null;
let Unicode11AddonCtor: typeof import('@xterm/addon-unicode11').Unicode11Addon | null = null;
let SerializeAddonCtor: typeof import('@xterm/addon-serialize').SerializeAddon | null = null;
let CanvasAddonCtor: typeof import('@xterm/addon-canvas').CanvasAddon | null = null;
let ClipboardAddonCtor: typeof import('@xterm/addon-clipboard').ClipboardAddon | null = null;
let WebglAddonCtor: typeof import('@xterm/addon-webgl').WebglAddon | null = null;

const loadXtermCSS = async (logger: Logger): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  if (document.querySelector('style[data-xterm-css]') || document.querySelector('link[href*=\"xterm.css\"]')) {
    logger.debug('[TerminalCore] Xterm CSS already loaded');
    return;
  }

  try {
    logger.debug('[TerminalCore] Loading xterm CSS');
    await import('@xterm/xterm/css/xterm.css');
    await new Promise(resolve => setTimeout(resolve, 10));

    const marker = document.createElement('style');
    marker.setAttribute('data-xterm-css', 'loaded');
    document.head.appendChild(marker);
  } catch (error) {
    logger.warn('[TerminalCore] Failed to load xterm CSS', { error });
  }
};

const loadXtermModules = async (logger: Logger): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('xterm can only be loaded in a browser environment');
  }

  if (TerminalCtor) {
    return;
  }

  await loadXtermCSS(logger);

  const [
    { Terminal },
    { FitAddon },
    { SearchAddon },
    { WebLinksAddon },
    { Unicode11Addon },
    { SerializeAddon },
    { CanvasAddon },
    { ClipboardAddon },
    webglAddonModule
  ] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-search'),
    import('@xterm/addon-web-links'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-serialize'),
    import('@xterm/addon-canvas'),
    import('@xterm/addon-clipboard'),
    import('@xterm/addon-webgl').catch(() => ({ WebglAddon: null }))
  ]);

  TerminalCtor = Terminal;
  FitAddonCtor = FitAddon;
  SearchAddonCtor = SearchAddon;
  WebLinksAddonCtor = WebLinksAddon;
  Unicode11AddonCtor = Unicode11Addon;
  SerializeAddonCtor = SerializeAddon;
  CanvasAddonCtor = CanvasAddon;
  ClipboardAddonCtor = ClipboardAddon;
  WebglAddonCtor = webglAddonModule.WebglAddon;
};

// TerminalCore provides a focused wrapper around xterm and its addons.
export class TerminalCore {
  private terminal: import('@xterm/xterm').Terminal | null = null;
  private fitAddon: import('@xterm/addon-fit').FitAddon | null = null;
  private searchAddon: import('@xterm/addon-search').SearchAddon | null = null;
  private serializeAddon: import('@xterm/addon-serialize').SerializeAddon | null = null;
  private canvasAddon: import('@xterm/addon-canvas').CanvasAddon | null = null;
  private clipboardAddon: import('@xterm/addon-clipboard').ClipboardAddon | null = null;
  private webglAddon: import('@xterm/addon-webgl').WebglAddon | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private state: TerminalState = TerminalState.IDLE;
  private isDisposed = false;

  private searchResultsCallback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null = null;
  private currentSearchTerm = '';
  private currentSearchOptions: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {};

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

  // initialize creates the xterm instance and binds addons.
  async initialize(): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Cannot initialize a disposed TerminalCore');
    }

    if (this.terminal || this.state === TerminalState.INITIALIZING) {
      return;
    }

    this.setState(TerminalState.INITIALIZING);
    await loadXtermModules(this.logger);
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
      throw new Error('xterm module not loaded');
    }

    const defaultConfig: TerminalConfig = {
      cols: 80,
      rows: 24,
      theme: {
        background: '#1a1a1a',
        foreground: '#ffffff',
        cursor: '#ffffff',
        selection: '#ffffff40'
      },
      fontSize: 12,
      fontFamily: '\"SF Mono\", Monaco, \"Cascadia Code\", \"Roboto Mono\", Consolas, \"Courier New\", monospace',
      fontWeight: 'normal',
      fontWeightBold: 'bold',
      cursorBlink: true,
      scrollback: 1000,
      allowTransparency: false,
      convertEol: true,
      allowProposedApi: true,
      disableStdin: false,
      screenReaderMode: false,
      windowsMode: false,
      macOptionIsMeta: true,
      cursorStyle: 'block',
      cursorWidth: 1,
      logLevel: 'warn',
      tabStopWidth: 8,
      minimumContrastRatio: 1,
      smoothScrolling: false,
      rescaleOverlappingGlyphs: true,
      ignoreBracketedPasteMode: false,
      overviewRulerWidth: 0,
      letterSpacing: 0,
      lineHeight: 1.0,
      linkHandler: null,
      rightClickSelectsWord: false,
      devicePixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
    };

    const finalConfig = { ...defaultConfig, ...this.config };
    this.terminal = new TerminalCtor(finalConfig as import('@xterm/xterm').ITerminalOptions);
  }

  private async loadAddons(): Promise<void> {
    if (!this.terminal) {
      throw new Error('Terminal instance not created');
    }

    if (!FitAddonCtor || !SearchAddonCtor || !WebLinksAddonCtor || !Unicode11AddonCtor || !SerializeAddonCtor || !CanvasAddonCtor || !ClipboardAddonCtor) {
      throw new Error('Required xterm addons not loaded');
    }

    this.fitAddon = new FitAddonCtor();
    this.terminal.loadAddon(this.fitAddon);

    this.searchAddon = new SearchAddonCtor();
    this.terminal.loadAddon(this.searchAddon);
    this.searchAddon.onDidChangeResults((results: { resultIndex: number; resultCount: number }) => {
      if (!this.searchResultsCallback) {
        return;
      }
      const matchPositions = this.currentSearchTerm ? this.getSearchMatchPositions(this.currentSearchTerm, this.currentSearchOptions) : [];
      this.searchResultsCallback({ ...results, matchPositions });
    });

    const webLinksAddon = new WebLinksAddonCtor((_event, uri: string) => {
      if (uri.startsWith('http://') || uri.startsWith('https://')) {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }
    });
    this.terminal.loadAddon(webLinksAddon);

    const unicodeAddon = new Unicode11AddonCtor();
    this.terminal.loadAddon(unicodeAddon);
    this.terminal.unicode.activeVersion = '11';

    this.serializeAddon = new SerializeAddonCtor();
    this.terminal.loadAddon(this.serializeAddon);

    if (WebglAddonCtor && this.config.rendererType === 'webgl') {
      try {
        this.webglAddon = new WebglAddonCtor();
        this.terminal.loadAddon(this.webglAddon);
      } catch (error) {
        this.logger.warn('[TerminalCore] WebGL addon failed, falling back to Canvas', { error });
        this.canvasAddon = new CanvasAddonCtor();
        this.terminal.loadAddon(this.canvasAddon);
      }
    } else {
      this.canvasAddon = new CanvasAddonCtor();
      this.terminal.loadAddon(this.canvasAddon);
    }

    this.clipboardAddon = new ClipboardAddonCtor();
    this.terminal.loadAddon(this.clipboardAddon);
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
      if (callback) {
        this.terminal.write(data as string | Uint8Array, callback);
      } else {
        this.terminal.write(data as string | Uint8Array);
      }
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
  }

  serialize(): string {
    if (!this.serializeAddon) {
      return '';
    }
    return this.serializeAddon.serialize();
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
    if (!this.searchAddon) {
      return false;
    }
    this.currentSearchTerm = term;
    this.currentSearchOptions = options ?? {};
    return this.searchAddon.findNext(term, options);
  }

  findPrevious(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    if (!this.searchAddon) {
      return false;
    }
    this.currentSearchTerm = term;
    this.currentSearchOptions = options ?? {};
    return this.searchAddon.findPrevious(term, options);
  }

  clearSearch(): void {
    this.currentSearchTerm = '';
    this.searchAddon?.clearDecorations();
  }

  setSearchResultsCallback(callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null): void {
    this.searchResultsCallback = callback;
  }

  focus(): void {
    this.terminal?.focus();
  }

  setConnected(isConnected: boolean): void {
    this.setState(isConnected ? TerminalState.CONNECTED : TerminalState.READY);
  }

  forceResize(): void {
    this.performResize();
  }

  setTheme(theme: Record<string, string>): void {
    if (!this.terminal) {
      return;
    }
    this.terminal.options.theme = theme;
    if (typeof this.terminal.clearTextureAtlas === 'function') {
      this.terminal.clearTextureAtlas();
    }
    if (typeof this.terminal.refresh === 'function') {
      const rows = this.terminal.rows ?? 0;
      this.terminal.refresh(0, Math.max(0, rows - 1));
    }
  }

  setFontSize(size: number): void {
    if (!this.terminal) {
      return;
    }
    this.terminal.options.fontSize = size;
    if (typeof this.terminal.clearTextureAtlas === 'function') {
      this.terminal.clearTextureAtlas();
    }
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

  private getSearchMatchPositions(term: string, options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): number[] {
    if (!this.searchAddon || !term) {
      return [];
    }

    const positions: number[] = [];
    const searchRegex = options.regex
      ? new RegExp(term, options.caseSensitive ? 'g' : 'gi')
      : new RegExp(term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), options.caseSensitive ? 'g' : 'gi');

    const lines = this.terminal?.buffer.active.length ?? 0;
    for (let i = 0; i < lines; i += 1) {
      const line = this.terminal?.buffer.active.getLine(i)?.translateToString() ?? '';
      if (options.wholeWord) {
        const words = line.split(/\\b/);
        if (words.some(word => word === term)) {
          positions.push(i);
        }
      } else if (searchRegex.test(line)) {
        positions.push(i);
      }
    }

    return positions;
  }
}
