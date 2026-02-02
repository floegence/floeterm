import { filterXtermAutoResponses } from '../utils/xtermAutoResponseFilter';
import { createConsoleLogger, noopLogger } from '../utils/logger';
import { TerminalState, type Logger, type TerminalConfig, type TerminalEventHandlers, type TerminalResponsiveConfig } from '../types';

type terminal_search_match = {
  row: number;
  col: number;
  len: number;
};

type terminal_search_overlay = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  termCanvas: HTMLCanvasElement;
};

const TERMINAL_SEARCH_MAX_RESULTS = 5000;

// Search highlighting: all matches use yellow background; active match uses yellow + red text.
const TERMINAL_SEARCH_MATCH_BACKGROUND = 'rgba(255, 234, 0, 0.38)';
const TERMINAL_SEARCH_ACTIVE_BACKGROUND = 'rgba(255, 234, 0, 0.72)';
const TERMINAL_SEARCH_ACTIVE_FOREGROUND = '#dc2626';

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
  private focusResizeRaf: number | null = null;
  private state: TerminalState = TerminalState.IDLE;
  private isDisposed = false;

  private isReplayingHistory = false;
  private replayingHistoryTimer: ReturnType<typeof setTimeout> | null = null;

  private logger: Logger;
  private eventHandlers: TerminalEventHandlers;
  private responsive: Required<TerminalResponsiveConfig>;

  private hasFocus = false;
  private resizeNotifySeq = 0;
  private lastNotifiedSize: { cols: number; rows: number } | null = null;

  private unbindResponsiveListeners: (() => void) | null = null;

  private searchQuery = '';
  private searchOptionsKey = '';
  private searchMatches: terminal_search_match[] = [];
  private searchMatchIndex = -1;
  private searchRowIndex = new Map<number, terminal_search_match[]>();
  private searchResultsCallback:
    | ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void)
    | null = null;

  private searchOverlay: terminal_search_overlay | null = null;
  private searchOverlayRaf: number | null = null;
  private searchOverlayUnsubs: Array<() => void> = [];

  // Temporary theme override while search is active.
  private searchThemeRestore: Record<string, string> | null = null;

  constructor(
    private container: HTMLElement,
    private config: TerminalConfig = {},
    eventHandlers: TerminalEventHandlers = {},
    logger: Logger = createConsoleLogger()
  ) {
    this.eventHandlers = eventHandlers;
    this.logger = logger ?? noopLogger;
    this.responsive = TerminalCore.normalizeResponsiveConfig(config?.responsive);
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
    this.setupResponsiveListeners();
    this.startSizeWatching();

    this.setState(TerminalState.READY);

    setTimeout(() => {
      if (!this.isReady()) {
        return;
      }
      // Defer the initial fit slightly to ensure the container has stable layout and fonts are ready.
      this.performResize('post_init');
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
      this.terminal.onResize((size: { cols: number; rows: number }) => {
        this.emitResize(size, { source: 'terminal' });
      });
    }
  }

  private setupResponsiveListeners(): void {
    const enabled = this.responsive.fitOnFocus || this.responsive.emitResizeOnFocus || this.responsive.notifyResizeOnlyWhenFocused;
    if (!enabled) {
      return;
    }

    const onFocusIn = () => {
      this.hasFocus = true;
      this.scheduleFocusResize();
    };

    const onFocusOut = () => {
      // focusout fires even when moving focus within the subtree; re-check on next frame.
      requestAnimationFrame(() => {
        if (this.isDisposed) {
          return;
        }
        this.hasFocus = this.isContainerFocused();
      });
    };

    const onPointerDown = () => {
      // pointerdown can happen before focus moves; treat it as "intent to interact".
      this.hasFocus = true;
      this.scheduleFocusResize();
    };

    this.container.addEventListener('focusin', onFocusIn);
    this.container.addEventListener('focusout', onFocusOut);
    this.container.addEventListener('pointerdown', onPointerDown);

    this.hasFocus = this.isContainerFocused();

    this.unbindResponsiveListeners = () => {
      this.container.removeEventListener('focusin', onFocusIn);
      this.container.removeEventListener('focusout', onFocusOut);
      this.container.removeEventListener('pointerdown', onPointerDown);
    };
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
      this.performResize('observer');
    }, 16);
  }

  private performResize(reason: 'observer' | 'focus' | 'force' | 'post_init'): void {
    if (!this.isReady() || !this.fitAddon || !this.terminal) {
      return;
    }

    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) {
      return;
    }

    const startSeq = this.resizeNotifySeq;
    const before = this.lastNotifiedSize;

    try {
      this.fitAddon.fit();
    } catch (error) {
      this.logger.debug('[TerminalCore] Resize failed', { error });
    }

    // Some ghostty-web builds may not always emit onResize for programmatic fit().
    // Emit a deduped notification based on the actual terminal dimensions.
    if (this.resizeNotifySeq !== startSeq) {
      return;
    }

    const dims = this.getDimensions();
    if (reason === 'focus' && this.responsive.emitResizeOnFocus) {
      const force = Boolean(before) && before!.cols === dims.cols && before!.rows === dims.rows;
      this.emitResize(dims, { source: 'core', force });
      return;
    }

    this.emitResize(dims, { source: 'core' });
  }

  private scheduleFocusResize(): void {
    if (!this.responsive.fitOnFocus && !this.responsive.emitResizeOnFocus) {
      return;
    }
    if (this.focusResizeRaf !== null) {
      return;
    }
    this.focusResizeRaf = requestAnimationFrame(() => {
      this.focusResizeRaf = null;
      this.performResize('focus');
    });
  }

  private emitResize(size: { cols: number; rows: number }, opts: { source: 'terminal' | 'core'; force?: boolean }): void {
    if (!this.eventHandlers.onResize) {
      return;
    }
    if (this.responsive.notifyResizeOnlyWhenFocused && !this.hasFocus) {
      return;
    }

    const cols = typeof size?.cols === 'number' ? size.cols : 0;
    const rows = typeof size?.rows === 'number' ? size.rows : 0;

    if (!opts.force && this.lastNotifiedSize && this.lastNotifiedSize.cols === cols && this.lastNotifiedSize.rows === rows) {
      return;
    }

    this.lastNotifiedSize = { cols, rows };
    this.resizeNotifySeq += 1;

    try {
      this.eventHandlers.onResize({ cols, rows });
    } catch (error) {
      this.logger.warn('[TerminalCore] onResize handler threw', { error });
    }
  }

  private isContainerFocused(): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const el = document.activeElement;
    if (!el) {
      return false;
    }
    return this.container.contains(el);
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
    return this.findInternal(term, options, 1);
  }

  findPrevious(term: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    return this.findInternal(term, options, -1);
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.searchOptionsKey = '';
    this.searchMatches = [];
    this.searchRowIndex = new Map();
    this.searchMatchIndex = -1;
    this.clearActiveSearchSelection();
    this.disposeSearchOverlay();
    this.restoreSearchTheme();
    this.notifySearchResults();
  }

  setSearchResultsCallback(callback: ((results: { resultIndex: number; resultCount: number; matchPositions?: number[] }) => void) | null): void {
    this.searchResultsCallback = callback;
    this.notifySearchResults();
  }

  private notifySearchResults(): void {
    if (!this.searchResultsCallback) return;
    const count = this.searchMatches.length;
    const index = this.searchMatchIndex;
    try {
      this.searchResultsCallback({ resultIndex: index, resultCount: count });
    } catch (error) {
      this.logger.debug('[TerminalCore] Search results callback failed', { error });
    }
  }

  private findInternal(
    rawTerm: string,
    options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } | undefined,
    dir: 1 | -1
  ): boolean {
    if (!this.terminal || !this.isReady()) return false;

    const term = (rawTerm ?? '').trim();
    const key = JSON.stringify({
      term,
      caseSensitive: Boolean(options?.caseSensitive),
      wholeWord: Boolean(options?.wholeWord),
      regex: Boolean(options?.regex)
    });

    if (!term) {
      this.clearSearch();
      return false;
    }

    const shouldRescan = term !== this.searchQuery || key !== this.searchOptionsKey;
    this.searchQuery = term;
    this.searchOptionsKey = key;

    if (shouldRescan) {
      this.searchMatches = this.scanTerminalMatches(term, options);
      this.searchRowIndex = this.buildSearchRowIndex(this.searchMatches);
      this.searchMatchIndex = this.searchMatches.length > 0 ? (dir === 1 ? 0 : this.searchMatches.length - 1) : -1;
      this.ensureSearchTheme();
      this.ensureSearchOverlaySubscriptions();
      this.scheduleRenderSearchOverlay();
    } else if (this.searchMatches.length > 0) {
      this.searchMatchIndex = dir === 1
        ? (this.searchMatchIndex + 1) % this.searchMatches.length
        : (this.searchMatchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
    }

    const match = this.searchMatchIndex >= 0 ? this.searchMatches[this.searchMatchIndex] : null;
    if (!match) {
      this.clearActiveSearchSelection();
      this.scheduleRenderSearchOverlay();
      this.notifySearchResults();
      return false;
    }

    this.applySearchMatch(match);
    this.scheduleRenderSearchOverlay();
    this.notifySearchResults();
    return true;
  }

  private scanTerminalMatches(
    term: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }
  ): terminal_search_match[] {
    const t = this.terminal;
    if (!t) return [];

    const buffer = t.buffer?.active;
    if (!buffer || typeof buffer.length !== 'number') return [];

    const caseSensitive = Boolean(options?.caseSensitive);
    const query = caseSensitive ? term : term.toLowerCase();
    // 模糊搜索：按空白切分为多个 token（例如 "git status" -> ["git", "status"]）
    const tokens = query.split(/\s+/).filter(Boolean);

    let regex: RegExp | null = null;
    if (options?.regex) {
      try {
        regex = new RegExp(term, caseSensitive ? 'g' : 'gi');
      } catch {
        regex = null;
      }
    }

    const results: terminal_search_match[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row);
      if (!line) continue;

      const raw = line.translateToString(false);
      if (!raw) continue;

      const text = caseSensitive ? raw : raw.toLowerCase();

      if (regex) {
        regex.lastIndex = 0;
        for (;;) {
          const m = regex.exec(raw);
          if (!m || typeof m.index !== 'number') break;
          const len = Math.max(1, String(m[0] ?? '').length);
          results.push({ row, col: m.index, len });
          if (results.length >= TERMINAL_SEARCH_MAX_RESULTS) break;
          if (len <= 0) break;
          if (regex.lastIndex === m.index) regex.lastIndex += 1;
        }
      } else if (tokens.length <= 1) {
        const needle = query;
        let idx = 0;
        while (idx <= text.length - needle.length) {
          const at = text.indexOf(needle, idx);
          if (at < 0) break;
          if (options?.wholeWord && !this.isWholeWordMatch(text, at, needle.length)) {
            idx = at + Math.max(1, needle.length);
            continue;
          }
          results.push({ row, col: at, len: Math.max(1, needle.length) });
          if (results.length >= TERMINAL_SEARCH_MAX_RESULTS) break;
          idx = at + Math.max(1, needle.length);
        }
      } else {
        // Multi-token fuzzy: tokens must appear in order; highlight the full span.
        let from = 0;
        let start = -1;
        let end = -1;
        let ok = true;
        for (const token of tokens) {
          const at = text.indexOf(token, from);
          if (at < 0) {
            ok = false;
            break;
          }
          if (start < 0) start = at;
          end = at + token.length;
          from = end;
        }
        if (ok && start >= 0 && end > start) {
          const len = end - start;
          if (!options?.wholeWord || this.isWholeWordMatch(text, start, len)) {
            results.push({ row, col: start, len });
          }
        }
      }

      if (results.length >= TERMINAL_SEARCH_MAX_RESULTS) break;
    }

    // Prefer recent output: sort from bottom to top.
    results.sort((a, b) => {
      const dr = b.row - a.row;
      if (dr !== 0) return dr;
      return a.col - b.col;
    });

    return results;
  }

  private buildSearchRowIndex(matches: terminal_search_match[]): Map<number, terminal_search_match[]> {
    const byRow = new Map<number, terminal_search_match[]>();
    for (const m of matches) {
      const list = byRow.get(m.row);
      if (list) list.push(m);
      else byRow.set(m.row, [m]);
    }
    return byRow;
  }

  private isWholeWordMatch(haystack: string, start: number, len: number): boolean {
    const before = start > 0 ? haystack[start - 1] : '';
    const after = start + len < haystack.length ? haystack[start + len] : '';
    const isWordChar = (ch: string) => /[0-9A-Za-z_]/.test(ch);
    if (before && isWordChar(before)) return false;
    if (after && isWordChar(after)) return false;
    return true;
  }

  private applySearchMatch(match: terminal_search_match): void {
    const t: any = this.terminal;
    if (!t) return;

    const scrollbackLen = typeof t.getScrollbackLength === 'function' ? t.getScrollbackLength() : 0;
    const rows = typeof t.rows === 'number' ? t.rows : 24;

    // Center the match line in viewport when possible.
    const desiredTop =
      match.row >= scrollbackLen ? scrollbackLen : Math.max(0, Math.min(scrollbackLen, match.row - Math.floor(rows / 2)));
    const viewportY = Math.max(0, Math.min(scrollbackLen, scrollbackLen - desiredTop));
    if (typeof t.scrollToLine === 'function') t.scrollToLine(viewportY);

    const sm = t?.selectionManager;
    const startCol = Math.max(0, match.col);
    const endCol = Math.max(startCol, startCol + Math.max(1, match.len) - 1);

    if (sm) {
      this.patchSearchSelectionManager(sm);
      sm.__floeterm_searchAllowSingleCellSelection = true;
      sm.markCurrentSelectionDirty?.();
      sm.selectionStart = { col: startCol, absoluteRow: match.row };
      sm.selectionEnd = { col: endCol, absoluteRow: match.row };
      sm.markCurrentSelectionDirty?.();
      sm.selectionChangedEmitter?.fire?.();
      return;
    }

    // Fallback: select within viewport row (may fail for scrollback).
    const viewportRow = Math.max(0, Math.min(rows - 1, Math.floor(rows / 2)));
    if (typeof t.select === 'function') {
      t.select(startCol, viewportRow, Math.max(1, match.len));
    }
  }

  private clearActiveSearchSelection(): void {
    const t: any = this.terminal;
    const sm = t?.selectionManager;
    if (sm) {
      sm.__floeterm_searchAllowSingleCellSelection = false;
    }
    if (t?.clearSelection) {
      try {
        t.clearSelection();
      } catch {
      }
    }
  }

  private patchSearchSelectionManager(sm: any): void {
    if (!sm || sm.__floeterm_searchPatched) return;
    const original = typeof sm.hasSelection === 'function' ? sm.hasSelection.bind(sm) : null;
    if (!original) return;
    sm.__floeterm_searchPatched = true;
    sm.__floeterm_searchAllowSingleCellSelection = false;
    sm.hasSelection = () => {
      // Keep original mouse selection semantics, but allow a single-cell selection for search.
      if (sm.__floeterm_searchAllowSingleCellSelection && sm.selectionStart && sm.selectionEnd) return true;
      return original();
    };
  }

  private ensureSearchTheme(): void {
    if (!this.terminal) return;
    if (this.searchThemeRestore) return;

    const terminalAny: any = this.terminal;
    const rendererTheme = terminalAny?.renderer?.theme;
    const base = rendererTheme && typeof rendererTheme === 'object' ? { ...rendererTheme } : mapThemeToGhostty(this.config.theme);
    this.searchThemeRestore = { ...base };

    const themed = this.applySearchThemeOverride(base);
    this.applyRendererTheme(terminalAny, themed);
  }

  private restoreSearchTheme(): void {
    if (!this.terminal) return;
    if (!this.searchThemeRestore) return;
    const terminalAny: any = this.terminal;
    const restore = this.searchThemeRestore;
    this.searchThemeRestore = null;
    this.applyRendererTheme(terminalAny, restore);
  }

  private applySearchThemeOverride(theme: Record<string, string>): Record<string, string> {
    return {
      ...theme,
      selectionBackground: TERMINAL_SEARCH_ACTIVE_BACKGROUND,
      selectionForeground: TERMINAL_SEARCH_ACTIVE_FOREGROUND,
      selection: TERMINAL_SEARCH_ACTIVE_BACKGROUND
    };
  }

  private applyRendererTheme(
    terminalAny: {
      isOpen?: boolean;
      renderer?: { setTheme?: (theme: Record<string, string>) => void; render?: (...args: unknown[]) => void };
      wasmTerm?: unknown;
      viewportY?: number;
      scrollbarOpacity?: number;
    },
    theme: Record<string, string>
  ): void {
    // ghostty-web emits a warning when mutating options.theme after open().
    // Apply theme directly to the renderer to avoid noisy console output.
    if (!terminalAny.isOpen && this.terminal) {
      this.terminal.options.theme = theme;
    }

    terminalAny.renderer?.setTheme?.(theme);

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

  private ensureSearchOverlaySubscriptions(): void {
    const t: any = this.terminal;
    if (!t) return;
    if (this.searchOverlayUnsubs.length > 0) return;

    // Keep overlay synced with scroll/resize.
    const onScroll = typeof t.onScroll === 'function' ? t.onScroll(() => this.scheduleRenderSearchOverlay()) : null;
    if (onScroll?.dispose) this.searchOverlayUnsubs.push(() => onScroll.dispose());
    const onResize = typeof t.onResize === 'function' ? t.onResize(() => this.scheduleRenderSearchOverlay()) : null;
    if (onResize?.dispose) this.searchOverlayUnsubs.push(() => onResize.dispose());
  }

  private disposeSearchOverlaySubscriptions(): void {
    for (const unsub of this.searchOverlayUnsubs) unsub();
    this.searchOverlayUnsubs = [];
  }

  private disposeSearchOverlay(): void {
    if (this.searchOverlayRaf !== null) {
      cancelAnimationFrame(this.searchOverlayRaf);
      this.searchOverlayRaf = null;
    }
    this.disposeSearchOverlaySubscriptions();
    if (this.searchOverlay?.canvas?.parentElement) {
      this.searchOverlay.canvas.parentElement.removeChild(this.searchOverlay.canvas);
    }
    this.searchOverlay = null;
  }

  private ensureSearchOverlay(): terminal_search_overlay | null {
    const t: any = this.terminal;
    if (!t) return null;
    const renderer = t?.renderer;
    const termCanvas = renderer?.getCanvas?.() as HTMLCanvasElement | undefined;
    if (!termCanvas) return null;

    // Ensure we have a positioning context.
    try {
      const style = getComputedStyle(this.container);
      if (style.position === 'static') this.container.style.position = 'relative';
    } catch {
    }

    if (this.searchOverlay && this.searchOverlay.termCanvas !== termCanvas) {
      this.disposeSearchOverlay();
    }

    if (!this.searchOverlay) {
      const overlay = document.createElement('canvas');
      overlay.style.position = 'absolute';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.pointerEvents = 'none';
      overlay.style.zIndex = '5';
      const ctx = overlay.getContext('2d');
      if (!ctx) return null;
      this.container.appendChild(overlay);
      this.searchOverlay = {
        canvas: overlay,
        ctx,
        dpr: 1,
        cssWidth: 0,
        cssHeight: 0,
        termCanvas
      };
    }

    const cssWidth = termCanvas.getBoundingClientRect().width;
    const cssHeight = termCanvas.getBoundingClientRect().height;
    const dpr = cssWidth > 0 ? termCanvas.width / cssWidth : window.devicePixelRatio ?? 1;

    if (
      this.searchOverlay.canvas.width !== termCanvas.width ||
      this.searchOverlay.canvas.height !== termCanvas.height ||
      this.searchOverlay.cssWidth !== cssWidth ||
      this.searchOverlay.cssHeight !== cssHeight ||
      this.searchOverlay.dpr !== dpr
    ) {
      this.searchOverlay.dpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
      this.searchOverlay.cssWidth = cssWidth;
      this.searchOverlay.cssHeight = cssHeight;
      this.searchOverlay.canvas.style.width = `${cssWidth}px`;
      this.searchOverlay.canvas.style.height = `${cssHeight}px`;
      this.searchOverlay.canvas.width = termCanvas.width;
      this.searchOverlay.canvas.height = termCanvas.height;
      this.searchOverlay.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.searchOverlay.ctx.scale(this.searchOverlay.dpr, this.searchOverlay.dpr);
    }

    return this.searchOverlay;
  }

  private scheduleRenderSearchOverlay(): void {
    if (this.searchOverlayRaf !== null) return;
    this.searchOverlayRaf = requestAnimationFrame(() => {
      this.searchOverlayRaf = null;
      this.renderSearchOverlay();
    });
  }

  private renderSearchOverlay(): void {
    const overlay = this.ensureSearchOverlay();
    if (!overlay) return;

    const t: any = this.terminal;
    const queryActive = this.searchQuery.trim().length > 0;
    const rowIndex = this.searchRowIndex;

    if (!queryActive || rowIndex.size === 0 || !t) {
      overlay.ctx.clearRect(0, 0, overlay.cssWidth, overlay.cssHeight);
      return;
    }

    const renderer = t?.renderer;
    const charW = typeof renderer?.charWidth === 'number' ? renderer.charWidth : 0;
    const charH = typeof renderer?.charHeight === 'number' ? renderer.charHeight : 0;
    const cols = typeof t.cols === 'number' ? t.cols : 0;
    const rows = typeof t.rows === 'number' ? t.rows : 0;
    const scrollbackLen = typeof t.getScrollbackLength === 'function' ? t.getScrollbackLength() : 0;
    const viewportY = Math.max(0, Math.floor(typeof t.getViewportY === 'function' ? t.getViewportY() : t.viewportY ?? 0));
    const viewportTop = Math.max(0, scrollbackLen - viewportY);

    if (charW <= 0 || charH <= 0 || cols <= 0 || rows <= 0) {
      overlay.ctx.clearRect(0, 0, overlay.cssWidth, overlay.cssHeight);
      return;
    }

    overlay.ctx.clearRect(0, 0, overlay.cssWidth, overlay.cssHeight);
    overlay.ctx.fillStyle = TERMINAL_SEARCH_MATCH_BACKGROUND;

    for (let y = 0; y < rows; y += 1) {
      const absRow = viewportTop + y;
      const list = rowIndex.get(absRow);
      if (!list || list.length === 0) continue;
      for (const m of list) {
        const col = Math.max(0, Math.min(cols - 1, m.col));
        const maxLen = Math.max(0, cols - col);
        const len = Math.max(0, Math.min(maxLen, m.len));
        if (len <= 0) continue;
        overlay.ctx.fillRect(col * charW, y * charH, len * charW, charH);
      }
    }
  }

  focus(): void {
    this.terminal?.focus();
  }

  setConnected(isConnected: boolean): void {
    this.setState(isConnected ? TerminalState.CONNECTED : TerminalState.READY);
  }

  forceResize(): void {
    this.performResize('force');
    this.forceFullRender();
  }

  setTheme(theme: Record<string, string>): void {
    const mapped = mapThemeToGhostty(theme);
    // Persist latest theme so a future re-initialization can reuse it.
    this.config = { ...this.config, theme: mapped };

    if (!this.terminal) {
      return;
    }

    const terminalAny = this.terminal as unknown as {
      isOpen?: boolean;
      renderer?: { setTheme?: (theme: Record<string, string>) => void; render?: (...args: unknown[]) => void };
      wasmTerm?: unknown;
      viewportY?: number;
      scrollbarOpacity?: number;
    };

    // If search is active, apply the theme but keep the search selection colors.
    if (this.searchQuery.trim().length > 0) {
      this.searchThemeRestore = { ...mapped };
      this.applyRendererTheme(terminalAny, this.applySearchThemeOverride(mapped));
      this.scheduleRenderSearchOverlay();
      return;
    }

    this.applyRendererTheme(terminalAny, mapped);
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
    if (this.focusResizeRaf !== null) {
      cancelAnimationFrame(this.focusResizeRaf);
      this.focusResizeRaf = null;
    }
    this.unbindResponsiveListeners?.();
    this.unbindResponsiveListeners = null;
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
    this.disposeSearchOverlay();
    this.terminal?.dispose();
    this.terminal = null;
    this.setState(TerminalState.DISPOSED);
  }

  private static normalizeResponsiveConfig(value: unknown): Required<TerminalResponsiveConfig> {
    const raw = (typeof value === 'object' && value) ? (value as Partial<TerminalResponsiveConfig>) : {};
    return {
      fitOnFocus: Boolean(raw.fitOnFocus),
      emitResizeOnFocus: Boolean(raw.emitResizeOnFocus),
      notifyResizeOnlyWhenFocused: Boolean(raw.notifyResizeOnlyWhenFocused),
    };
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
