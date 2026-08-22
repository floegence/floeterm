import type { RendererSurface } from './RendererSurface.js';
import type {
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticFrame,
  SemanticPresentation,
} from './presentation.js';
import {
  isStructuralSemanticHistoryError,
  SemanticHistoryError,
  validateHistoryWindow,
  validateHistoryViewport,
} from './presentation.js';
import { runSemanticHistoryRequest } from './historyRequestScheduler.js';

function emitSemanticDebugTrace(event: Readonly<Record<string, unknown>>): void {
  const target = globalThis as typeof globalThis & {
    __floetermSemanticTrace?: (event: Readonly<Record<string, unknown>>) => void;
  };
  target.__floetermSemanticTrace?.(event);
}

export type HistoryViewportState = Readonly<{
  browsing: boolean;
  busy: boolean;
  offset: number;
  totalRows: number;
  screenStartOffset: number;
  error: Error | null;
}>;

export type HistoryViewportCacheMetrics = Readonly<{
  entries: number;
  bytes: number;
  extraBytes: number;
  extraCells: number;
}>;

export type HistoryViewportControllerOptions = Readonly<{
  renderer: Pick<RendererSurface, 'apply' | 'project' | 'getCellMetrics'>
    & Partial<Pick<RendererSurface, 'projectInCurrentAnimationFrame'>>;
  request: (request: SemanticHistoryRequest) => Promise<SemanticHistoryViewport>;
  onState?: (state: HistoryViewportState) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
  now?: () => number;
}>;

type CachedViewport = Readonly<{
  viewport: SemanticHistoryViewport;
  touched: number;
  bytes: number;
  cells: number;
}>;
// History is owned by a single terminal session. Keep the budget local to the
// controller so one busy session cannot evict another session's history.
const MAX_SESSION_HISTORY_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_PAGE_HISTORY_CACHE_BYTES = 128 * 1024 * 1024;
const HISTORY_WINDOW_CACHE_TARGET_BYTES = Math.floor(MAX_SESSION_HISTORY_CACHE_BYTES * 0.85);
const HISTORY_WINDOW_BASE_MULTIPLIER = 10;
const HISTORY_WINDOW_FAST_MULTIPLIER = 20;
const HISTORY_WINDOW_MAX_ROWS = 4_000;
const HISTORY_SCROLL_BURST_GAP_MS = 250;
const HISTORY_SCROLL_BURST_DECAY_MS = 500;
const HISTORY_SCROLL_BURST_VIEWPORTS = 2;
const HISTORY_WINDOW_FORWARD_BIAS = 0.7;
const HISTORY_PREFETCH_DELAY_MS = 500;
const HISTORY_PREFETCH_SCREENS = 100;
const HISTORY_PREFETCH_FRONT_SCREENS = 80;

export class HistoryViewportController {
  private static readonly instances = new Set<HistoryViewportController>();
  private latest: SemanticPresentation | null = null;
  private visible: SemanticHistoryViewport | null = null;
  private frontier: SemanticHistoryViewport | null = null;
  private readonly cache = new Map<string, CachedViewport>();
  private cacheBytes = 0;
  private historyAnchor: string | null = null;
  private desiredOffset: number | null = null;
  private lane: Promise<void> | null = null;
  private epoch = 0;
  private transportGeneration: number | null = null;
  private touch = 0;
  private disposed = false;
  private error: Error | null = null;
  private wheelResidualRows = 0;
  private wheelFrame: number | null = null;
  private handlingWheelFrame = false;
  private preferExactViewport = false;
  private scrollDirection: -1 | 0 | 1 = 0;
  private scrollBurstDirection: -1 | 0 | 1 = 0;
  private scrollBurstRows = 0;
  private scrollBurstAt = 0;
  private estimatedHistoryRowBytes = 0;
  private pendingProjection = false;
  private skeletonSequence = 0;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;
  private nextRequestID = 0;
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  private prefetchAbort: AbortController | null = null;
  private prefetchTask: Promise<void> | null = null;

  constructor(private readonly options: HistoryViewportControllerOptions) {
    HistoryViewportController.instances.add(this);
    this.requestFrame = options.requestAnimationFrame
      ?? globalThis.requestAnimationFrame?.bind(globalThis)
      ?? (callback => globalThis.setTimeout(() => callback(performance.now()), 0) as unknown as number);
    this.cancelFrame = options.cancelAnimationFrame
      ?? globalThis.cancelAnimationFrame?.bind(globalThis)
      ?? (handle => globalThis.clearTimeout(handle));
    this.now = options.now ?? (() => performance.now());
  }

  apply(presentation: SemanticPresentation): void {
    if (this.disposed) return;
    const previous = this.latest;
    const invalidated = previous !== null && (
      (previous.state.contentEpoch ?? 0) !== (presentation.state.contentEpoch ?? 0)
      || previous.geometry.generation !== presentation.geometry.generation
      || previous.geometry.cols !== presentation.geometry.cols
      || previous.geometry.rows !== presentation.geometry.rows
      || (previous.frame.history.historyEpoch !== undefined
        && presentation.frame.history.historyEpoch !== undefined
        && previous.frame.history.historyEpoch !== presentation.frame.history.historyEpoch)
    );
    this.latest = presentation;
    this.options.renderer.apply(presentation);
    if (invalidated) {
      this.resetHistory(true);
    } else if (previous) {
      this.remapActiveHistory(previous);
    }
    this.emitState();
  }

  scrollByRows(deltaRows: number): void {
    if (this.disposed || !this.latest || !Number.isFinite(deltaRows)) return;
    const rows = Math.trunc(deltaRows);
    if (rows === 0) return;
    const current = this.currentIntentOffset();
    const target = clamp(current + rows, 0, this.latest.frame.history.screenStartOffset);
    this.showOffset(target);
  }

  handleWheel(delta: number, deltaMode: number): void {
    if (this.disposed || !this.latest || !Number.isFinite(delta)) return;
    const viewportRows = this.latest.geometry.rows;
    const rows = deltaMode === 1
      ? delta
      : deltaMode === 2
        ? delta * viewportRows
        : delta / this.options.renderer.getCellMetrics().cellHeightCssPx;
    this.wheelResidualRows += rows;
    if (Math.abs(rows) >= viewportRows) this.preferExactViewport = true;
    if (this.wheelFrame !== null) return;
    this.wheelFrame = this.requestFrame(() => {
      this.wheelFrame = null;
      this.handlingWheelFrame = true;
      try {
        const wholeRows = this.wheelResidualRows < 0
          ? Math.ceil(this.wheelResidualRows)
          : Math.floor(this.wheelResidualRows);
        this.wheelResidualRows -= wholeRows;
        this.scrollByRows(wholeRows);
      } finally {
        this.handlingWheelFrame = false;
      }
    });
  }

  showStart(): void {
    this.showOffset(0);
  }

  showLatest(): void {
    if (!this.latest || this.disposed) return;
    // Invalidate any history request that was started before returning to the
    // live frontier. Its response must never re-enter the visible surface.
    this.epoch += 1;
    this.cancelPrefetch();
    this.desiredOffset = null;
    this.preferExactViewport = false;
    this.visible = null;
    this.error = null;
    this.projectFrame(null);
    this.evictCache();
    this.emitState();
  }

  showOffset(offset: number): void {
    if (!this.latest || this.disposed || !Number.isFinite(offset)) return;
    const target = clamp(Math.trunc(offset), 0, this.latest.frame.history.screenStartOffset);
    this.cancelPrefetch();
    const current = this.currentIntentOffset();
    this.recordScrollIntent(target - current);
    emitSemanticDebugTrace({ kind: 'history-cache-check', at: performance.now(), target,
      frontierOffset: this.frontier?.offset ?? null, frontierRows: this.frontier?.rows ?? null,
      cacheEntries: this.cache.size, cacheBytes: this.cacheBytes,
      cacheExtraBytes: this.cacheExtraBytes() });
    if (target === this.latest.frame.history.screenStartOffset) {
      this.showLatest();
      return;
    }
    const cached = this.findCachedViewport(target);
    if (cached) {
      this.desiredOffset = null;
      this.display(cached);
      return;
    }
    // The active frontier is the hottest window. Keep it usable even if the
    // bounded LRU has evicted its map entry between adjacent wheel frames.
    const frontierWindow = this.frontier;
    if (frontierWindow && this.isReusableWindow(frontierWindow, target, this.latest.geometry.rows)) {
      this.desiredOffset = null;
      this.display(this.sliceWindow(frontierWindow, target, this.latest.geometry.rows));
      return;
    }
    const window = this.findCachedWindow(target, this.latest.geometry.rows);
    if (window) {
      this.desiredOffset = null;
      this.putCache(window);
      this.display(this.sliceWindow(window, target, this.latest.geometry.rows));
      return;
    }
    this.desiredOffset = target;
    this.error = null;
    // Project a geometry-stable placeholder before the first remote byte
    // arrives. This keeps the wheel gesture visible in the same animation
    // frame instead of leaving the old viewport on screen during the RTT.
    this.projectPending(target);
    this.startLane();
    this.emitState();
  }

  private currentIntentOffset(): number {
    if (!this.latest) return 0;
    const liveOffset = this.latest.frame.history.screenStartOffset;
    if (this.desiredOffset !== null) return clamp(this.desiredOffset, 0, liveOffset);
    if (!this.visible) return liveOffset;
    // A bounded runtime scrollback may evict old rows while an immutable
    // history snapshot remains visible. Its old absolute offset can then sit
    // beyond the new live frontier. Preserve the viewport's distance from the
    // tail before applying the next user delta; clamping the stale absolute
    // coordinate directly would incorrectly jump the user back to live.
    if (this.visible.screenStartOffset > liveOffset) {
      const distanceFromLive = this.visible.screenStartOffset - this.visible.offset;
      return clamp(liveOffset - distanceFromLive, 0, liveOffset);
    }
    return clamp(this.visible.offset, 0, liveOffset);
  }

  setVisible(_visible: boolean): void {
    if (this.disposed) return;
    // Keep this session's bounded history cache warm while another workbench
    // view is active. Every reuse still passes the live revision, content,
    // geometry, and transport-generation checks; retaining the immutable
    // window therefore removes the first-scroll cold RPC without permitting
    // stale terminal content to be projected after returning to this view.
  }

  reset(): void {
    if (this.disposed) return;
    this.resetHistory(true);
  }

  setTransportGeneration(generation: number | null): void {
    if (this.disposed) return;
    if (generation !== null && (!Number.isSafeInteger(generation) || generation <= 0)) {
      throw new Error('terminal history transport generation is invalid');
    }
    if (this.transportGeneration === generation) return;
    this.transportGeneration = generation;
    this.resetHistory(true);
  }

  getState(): HistoryViewportState {
    const history = this.latest?.frame.history;
    return Object.freeze({
      browsing: this.visible !== null,
      busy: this.lane !== null,
      offset: this.visible?.offset ?? history?.screenStartOffset ?? 0,
      totalRows: history?.totalRows ?? this.visible?.totalRows ?? 0,
      screenStartOffset: history?.screenStartOffset ?? this.visible?.screenStartOffset ?? 0,
      error: this.error,
    });
  }

  getViewport(): SemanticHistoryViewport | null {
    return this.visible;
  }

  showViewport(viewport: SemanticHistoryViewport): void {
    if (this.disposed) return;
    viewport = validateHistoryViewport(viewport);
    this.assertTransportGeneration(viewport);
    if (!this.latest
      || viewport.contentEpoch !== (this.latest.state.contentEpoch ?? 0)
      || viewport.geometryGeneration !== this.latest.geometry.generation
      || viewport.cols !== this.latest.geometry.cols
      || viewport.rows !== this.latest.geometry.rows) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history viewport does not match the live surface');
    }
    this.desiredOffset = null;
    this.frontier = null;
    this.clearCache();
    this.historyAnchor = null;
    this.visible = viewport;
    this.error = null;
    this.options.renderer.project(viewport.frame);
    this.emitState();
  }

  getCacheMetrics(): HistoryViewportCacheMetrics {
    const extras = [...this.cache.values()].filter(item => item.viewport !== this.visible);
    const extraBytes = extras.reduce((sum, item) => sum + item.bytes, 0);
    const extraCells = extras.reduce((sum, item) => sum + item.cells, 0);
    return Object.freeze({ entries: this.cache.size, bytes: this.cacheBytes, extraBytes, extraCells });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.cancelPrefetch();
    HistoryViewportController.instances.delete(this);
    if (this.wheelFrame !== null) this.cancelFrame(this.wheelFrame);
    this.wheelFrame = null;
    this.clearCache();
    this.visible = null;
    this.frontier = null;
    this.desiredOffset = null;
  }

  private startLane(): void {
    if (this.lane || this.disposed) return;
    const epoch = this.epoch;
    this.lane = this.runLane(epoch).finally(() => {
      this.lane = null;
      this.emitState();
      if (!this.disposed && this.desiredOffset !== null) this.startLane();
    });
  }

  private async runLane(epoch: number): Promise<void> {
    try {
      while (!this.disposed && this.epoch === epoch) {
        const target = this.desiredOffset;
        if (target === null) return;
        const cached = this.findCachedViewport(target);
        if (cached) {
          const isCurrentTarget = this.desiredOffset === target;
          const desiredOffset = this.desiredOffset;
          if (isCurrentTarget) {
            this.desiredOffset = null;
          }
          // A completed, validated viewport is still useful while a newer
          // wheel target is in flight, but only while it moves toward that
          // target. Never project an older response after a direction change.
          if (isCurrentTarget || this.shouldDisplayIntermediate(cached.offset, desiredOffset)) {
            this.display(cached);
          }
          continue;
        }
        const cachedWindow = this.findCachedWindow(target, this.latest?.geometry.rows ?? 0);
        if (cachedWindow && this.latest) {
          const isCurrentTarget = this.desiredOffset === target;
          const desiredOffset = this.desiredOffset;
          if (isCurrentTarget) {
            this.desiredOffset = null;
          }
          this.putCache(cachedWindow);
          const viewport = this.sliceWindow(cachedWindow, target, this.latest.geometry.rows);
          if (isCurrentTarget || this.shouldDisplayIntermediate(viewport.offset, desiredOffset)) {
            this.display(viewport);
          }
          continue;
        }
        const viewport = await this.fetchOffset(target);
        if (this.disposed || this.epoch !== epoch) return;
        this.cacheViewport(viewport);
        const isCurrentTarget = this.desiredOffset === target;
        const desiredOffset = this.desiredOffset;
        if (isCurrentTarget) {
          this.desiredOffset = null;
        }
        if (isCurrentTarget || (!this.pendingProjection && this.shouldDisplayIntermediate(viewport.offset, desiredOffset))) {
          this.display(viewport);
        }
      }
    } catch (cause) {
      if (this.disposed || this.epoch !== epoch) return;
      this.error = cause instanceof Error ? cause : new Error(String(cause));
      this.frontier = null;
      this.desiredOffset = null;
      if (isStructuralSemanticHistoryError(this.error)) this.resetHistory(true, this.error);
    }
  }

  private async fetchOffset(target: number): Promise<SemanticHistoryViewport> {
    try {
      return await this.fetchOffsetAttempt(target);
    } catch (cause) {
      if (!isRecoverableHistoryLineageError(cause)) throw cause;
      this.frontier = null;
      this.clearCache();
      this.historyAnchor = null;
      return await this.fetchOffsetAttempt(this.desiredOffset ?? target);
    }
  }

  private async fetchOffsetAttempt(target: number): Promise<SemanticHistoryViewport> {
    if (!this.latest) throw new Error('terminal history requires a live Presentation');
    const rows = this.latest.geometry.rows;
    const totalRows = this.latest.frame.history.totalRows;
    const preferExactViewport = this.preferExactViewport;
    // A large wheel delta needs one exact target request, but must not poison
    // the rest of the session. Subsequent small deltas should use a reusable
    // history window again.
    this.preferExactViewport = false;
    const windowRows = preferExactViewport ? rows : this.adaptiveWindowRows(rows, totalRows);
    if (windowRows <= rows) return this.fetchExactFromBoundary(target, rows);
    const cachedWindow = this.findCachedWindow(target, rows);
    if (cachedWindow) return this.sliceWindow(cachedWindow, target, rows);
    let frontier = this.frontier;
    if (frontier && !this.isCompatibleWindow(frontier)) {
      this.frontier = null;
      frontier = null;
    }
    if (!frontier || !this.isReusableWindow(frontier, target, rows)) {
      frontier = await this.fetchWindow(target, rows, windowRows);
    }
    if (frontier.window !== true) return frontier;
    return this.sliceWindow(frontier, target, rows);
  }

  private async fetchExactFromBoundary(target: number, rows: number): Promise<SemanticHistoryViewport> {
    // A boundary request already supports exact targeting in one RPC and
    // atomically establishes its own native lineage. Reusing an old exact
    // frontier offers no round-trip saving, but it opens a race where live
    // output evicts the anchor after the client checks its revision and before
    // the runtime processes the anchored request.
    const frontier = validateHistoryViewport(await this.fetchBoundary(
      target === 0 ? 'start' : 'end', target, rows,
    ));
    this.assertTransportGeneration(frontier);
    this.acceptLineage(frontier, true);
    this.frontier = frontier;
    return this.fetchExactOffset(frontier, target, rows);
  }

  private async fetchExactOffset(
    frontier: SemanticHistoryViewport,
    target: number,
    rows: number,
  ): Promise<SemanticHistoryViewport> {
    if (frontier.offset === target) return frontier;
    const direction: SemanticHistoryRequest['direction'] = target < frontier.offset ? 'backward' : 'forward';
    const next = validateHistoryViewport(await runSemanticHistoryRequest(() => this.options.request({
      lane: 'viewport',
      direction,
      anchor: frontier.anchor,
      snapshotId: frontier.snapshotId,
      offset: frontier.offset,
      targetOffset: target,
      viewportRows: rows,
    })));
    this.assertTransportGeneration(next);
    this.acceptLineage(next);
    this.frontier = next;
    return next;
  }

  private async fetchWindow(target: number, rows: number, windowRows: number): Promise<SemanticHistoryViewport> {
    const windowStart = this.windowStart(target, rows, windowRows, this.scrollDirection);
    let current = this.frontier;
    if (current && this.isCompatibleWindow(current)
      && current.offset === windowStart && !this.isReusableWindow(current, target, rows)) {
      current = null;
    }
    if (!current || !this.isCompatibleWindow(current)) {
      // A start/end boundary request always replaces the server-side view for
      // this lane and therefore always establishes a new anchor. This is also
      // how an exact viewport is upgraded to a reusable window. Clear every
      // cache entry from the old lineage before accepting that replacement.
      const allowLineageReplacement = true;
      const response = await this.fetchBoundary(
        target === 0 ? 'start' : 'end', windowStart, windowRows, rows,
      );
      // Keep the old exact-viewport contract as a fallback for older runtimes
      // while the fast-debug runtime is being rolled out.
      if (response.window !== true) {
        current = validateHistoryViewport(response);
        this.assertTransportGeneration(current);
        this.acceptLineage(current, allowLineageReplacement);
        this.frontier = current;
        return this.fetchExactOffset(current, this.desiredOffset ?? target, rows);
      }
      current = validateHistoryWindow(response);
      this.assertTransportGeneration(current);
      this.acceptLineage(current, allowLineageReplacement);
      this.cacheWindow(current);
      // This boundary response is already one validated, immutable snapshot
      // captured for the requested target. Live output may advance `latest`
      // while the RPC and payload chunks are in flight, so revision equality
      // is no longer a valid reason to navigate away from this fresh window.
      // Doing so used to synthesize a zero-distance `forward` request when the
      // response started exactly at windowStart; the runtime correctly rejected
      // that request as an invalid anchor and continuous agent output could make
      // the single recovery attempt repeat the same race.
      this.frontier = current;
      if (this.windowCovers(current, target, rows)) return current;
      // Bounded native scrollback can legitimately move past the requested
      // absolute offset while the boundary capture is running. In that case,
      // project the nearest viewport that is actually present in this atomic
      // snapshot instead of issuing a directionally invalid anchored request.
      const nearest = clamp(target, current.offset, current.offset + current.rows - rows);
      return this.sliceWindow(current, nearest, rows);
    }
    if (!current) throw new Error('terminal history window is unavailable');
    if (this.isReusableWindow(current, target, rows)) {
      this.frontier = current;
      return current;
    }
    const direction: SemanticHistoryRequest['direction'] = windowStart < current.offset ? 'backward' : 'forward';
    const offset = current.offset;
    const next = validateHistoryWindow(await runSemanticHistoryRequest(() => this.options.request({
      lane: 'viewport',
      direction,
      anchor: current.anchor,
      snapshotId: current.snapshotId,
      offset,
      targetOffset: windowStart,
      viewportRows: windowRows,
      windowRows,
    })));
    this.assertTransportGeneration(next);
    this.acceptLineage(next);
    if (next.offset === offset || (direction === 'backward' && next.offset > offset)
      || (direction === 'forward' && next.offset < offset)) {
      throw new SemanticHistoryError('malformed_snapshot', 'semantic history window did not advance toward its target');
    }
    this.frontier = next;
    this.cacheWindow(next);
    return next;
  }

  private async fetchBoundary(
    direction: Extract<SemanticHistoryRequest['direction'], 'start' | 'end'>,
    target: number,
    viewportRows: number,
    legacyViewportRows = viewportRows,
  ): Promise<SemanticHistoryViewport> {
    try {
      return await runSemanticHistoryRequest(() => this.options.request({
        lane: 'viewport',
        direction,
        targetOffset: target,
        viewportRows,
        ...(viewportRows === legacyViewportRows ? {} : { windowRows: viewportRows }),
      }));
    } catch (cause) {
      if (!isLegacyBoundaryTargetRejection(cause)) throw cause;
      return await runSemanticHistoryRequest(() => this.options.request({
        lane: 'viewport',
        direction,
        viewportRows: legacyViewportRows,
      }));
    }
  }

  private windowStart(target: number, rows: number, windowRows: number, direction: -1 | 0 | 1): number {
    if (!this.latest) return target;
    const totalRows = this.latest.frame.history.totalRows;
    const maximum = Math.max(0, totalRows - windowRows);
    const bufferRows = Math.max(0, windowRows - rows);
    const rowsBeforeTarget = direction < 0
      ? Math.round(bufferRows * HISTORY_WINDOW_FORWARD_BIAS)
      : direction > 0
        ? Math.round(bufferRows * (1 - HISTORY_WINDOW_FORWARD_BIAS))
        : Math.round(bufferRows / 2);
    return clamp(target - rowsBeforeTarget, 0, maximum);
  }

  private adaptiveWindowRows(rows: number, totalRows: number): number {
    if (!this.latest) return rows;
    const now = this.now();
    const fast = this.scrollBurstDirection !== 0
      && now - this.scrollBurstAt <= HISTORY_SCROLL_BURST_DECAY_MS
      && this.scrollBurstRows >= rows * HISTORY_SCROLL_BURST_VIEWPORTS;
    const multiplier = fast ? HISTORY_WINDOW_FAST_MULTIPLIER : HISTORY_WINDOW_BASE_MULTIPLIER;
    const liveRowBytes = estimateFrameBytes(this.latest.frame) / Math.max(1, this.latest.frame.height);
    const rowBytes = Math.max(256, this.estimatedHistoryRowBytes || liveRowBytes);
    const cacheLimitedRows = Math.max(rows, Math.floor(HISTORY_WINDOW_CACHE_TARGET_BYTES / rowBytes));
    const windowRows = Math.max(rows, Math.min(
      totalRows,
      HISTORY_WINDOW_MAX_ROWS,
      rows * multiplier,
      cacheLimitedRows,
    ));
    emitSemanticDebugTrace({
      kind: 'history-window-plan', at: now, direction: this.scrollDirection,
      multiplier, viewportRows: rows, windowRows, cacheLimitedRows,
      estimatedHistoryRowBytes: rowBytes, scrollBurstRows: this.scrollBurstRows,
    });
    return windowRows;
  }

  private recordScrollIntent(deltaRows: number): void {
    if (deltaRows === 0) return;
    const direction = Math.sign(deltaRows) as -1 | 1;
    const now = this.now();
    if (direction === this.scrollBurstDirection
      && now - this.scrollBurstAt <= HISTORY_SCROLL_BURST_GAP_MS) {
      this.scrollBurstRows += Math.abs(deltaRows);
    } else {
      this.scrollBurstDirection = direction;
      this.scrollBurstRows = Math.abs(deltaRows);
    }
    this.scrollDirection = direction;
    this.scrollBurstAt = now;
  }

  private windowCovers(window: SemanticHistoryViewport, target: number, rows: number): boolean {
    return this.windowCoversOrdinal(window, target, rows);
  }

  private windowCoversOrdinal(window: SemanticHistoryViewport, target: number, rows: number): boolean {
    const targetOrdinal = this.offsetToOrdinal(target);
    if (targetOrdinal === null || window.firstRowOrdinal === undefined) {
      return target >= window.offset && target + rows <= window.offset + window.rows;
    }
    const windowStart = window.firstRowOrdinal + window.offset;
    return targetOrdinal >= windowStart && targetOrdinal + rows <= windowStart + window.rows;
  }

  private offsetToOrdinal(offset: number): number | null {
    const latest = this.latest?.frame.history;
    if (!latest || latest.firstRowOrdinal === undefined) return null;
    return latest.firstRowOrdinal + offset;
  }

  private sliceWindow(
    window: SemanticHistoryViewport,
    target: number,
    rows: number,
  ): SemanticHistoryViewport {
    const remapped = remapViewportOffset(window, target, this.latest);
    if (!remapped) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history window no longer covers its target ordinal');
    }
    return sliceHistoryWindow(remapped, target, rows);
  }

  private remapActiveHistory(previous: SemanticPresentation): void {
    if (!this.latest) return;
    const previousHistory = previous.frame.history;
    const currentHistory = this.latest.frame.history;
    if (previousHistory.historyEpoch === undefined || currentHistory.historyEpoch === undefined
      || previousHistory.firstRowOrdinal === undefined || currentHistory.firstRowOrdinal === undefined
      || previousHistory.historyEpoch !== currentHistory.historyEpoch) return;
    const previousFirstRowOrdinal = previousHistory.firstRowOrdinal;
    const currentFirstRowOrdinal = currentHistory.firstRowOrdinal;

    const remapOffset = (offset: number): number => clamp(
      previousFirstRowOrdinal + offset - currentFirstRowOrdinal,
      0,
      currentHistory.screenStartOffset,
    );
    if (this.desiredOffset !== null) this.desiredOffset = remapOffset(this.desiredOffset);
    if (!this.visible) return;

    const target = remapOffset(this.visible.offset);
    const remapped = remapViewportOffset(this.visible, target, this.latest);
    if (remapped) this.visible = remapped;
  }

  private display(viewport: SemanticHistoryViewport): void {
    this.visible = viewport;
    this.pendingProjection = false;
    this.error = null;
    this.putCache(viewport);
    this.projectFrame(viewport.frame);
    this.evictCache();
    this.schedulePrefetch();
    this.emitState();
  }

  private cacheViewport(viewport: SemanticHistoryViewport): void {
    this.putCache(viewport);
    this.evictCache();
  }

  private projectFrame(frame: SemanticHistoryViewport['frame'] | null): void {
    if (this.handlingWheelFrame && this.options.renderer.projectInCurrentAnimationFrame) {
      this.options.renderer.projectInCurrentAnimationFrame(frame);
      return;
    }
    this.options.renderer.project(frame);
  }

  private projectPending(target: number): void {
    if (!this.latest) return;
    this.pendingProjection = true;
    const pending = createPendingViewport(this.latest, target, this.transportGeneration ?? 1, ++this.skeletonSequence);
    this.visible = pending;
    emitSemanticDebugTrace({ kind: 'history-pending', at: performance.now(), target });
    this.projectFrame(pending.frame);
  }

  private evictCache(): void {
    for (;;) {
      const candidates = [...this.cache.entries()]
        .filter(([, item]) => item.viewport !== this.visible)
        .sort((left, right) => left[1].touched - right[1].touched);
      const extraBytes = candidates.reduce((sum, candidate) => sum + candidate[1].bytes, 0);
      if (extraBytes <= MAX_SESSION_HISTORY_CACHE_BYTES) break;
      const oldest = candidates[0];
      if (!oldest) break;
      this.removeCacheEntry(oldest[0]);
    }
    emitSemanticDebugTrace({ kind: 'history-cache-state', at: performance.now(),
      cacheEntries: this.cache.size, cacheBytes: this.cacheBytes,
      cacheExtraBytes: this.cacheExtraBytes() });
    HistoryViewportController.evictGlobalCaches();
  }

  private static evictGlobalCaches(): void {
    const extraBytes = (): number => [...HistoryViewportController.instances]
      .reduce((sum, controller) => sum + controller.cacheExtraBytes(), 0);
    while (extraBytes() > MAX_PAGE_HISTORY_CACHE_BYTES) {
      let oldest: HistoryViewportController | null = null;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const controller of HistoryViewportController.instances) {
        const touched = controller.oldestExtraTouched();
        if (touched < oldestTouched) {
          oldestTouched = touched;
          oldest = controller;
        }
      }
      if (!oldest || !Number.isFinite(oldestTouched)) break;
      oldest.removeOldestExtra();
    }
  }

  private oldestExtraTouched(): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const item of this.cache.values()) {
      if (item.viewport !== this.visible) oldest = Math.min(oldest, item.touched);
    }
    return oldest;
  }

  private removeOldestExtra(): void {
    let key: string | null = null;
    let touched = Number.POSITIVE_INFINITY;
    for (const [entryKey, item] of this.cache.entries()) {
      if (item.viewport !== this.visible && item.touched < touched) {
        key = entryKey;
        touched = item.touched;
      }
    }
    if (key !== null) this.removeCacheEntry(key);
  }

  private schedulePrefetch(): void {
    if (this.disposed || !this.frontier || this.frontier.window !== true) return;
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    const epoch = this.epoch;
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null;
      void this.runPrefetch(epoch);
    }, HISTORY_PREFETCH_DELAY_MS);
  }

  private cancelPrefetch(): void {
    if (this.prefetchTimer !== null) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = null;
    this.prefetchAbort?.abort();
    this.prefetchAbort = null;
    this.prefetchTask = null;
  }

  private async runPrefetch(epoch: number): Promise<void> {
    const current = this.frontier;
    const latest = this.latest;
    if (this.disposed || epoch !== this.epoch || !latest || !current || current.window !== true) return;
    const rows = latest.geometry.rows;
    const direction = this.scrollDirection || -1;
    const totalRows = latest.frame.history.totalRows;
    const windowRows = Math.min(
      totalRows,
      HISTORY_WINDOW_MAX_ROWS,
      Math.max(rows, rows * HISTORY_PREFETCH_SCREENS),
    );
    const frontRows = rows * HISTORY_PREFETCH_FRONT_SCREENS;
    const target = clamp(
      current.offset + (direction < 0 ? -frontRows : frontRows),
      0,
      Math.max(0, totalRows - rows),
    );
    const windowStart = this.windowStart(target, rows, windowRows, direction);
    const abort = new AbortController();
    this.prefetchAbort = abort;
    const requestID = `prefetch-${++this.nextRequestID}`;
    this.prefetchTask = runSemanticHistoryRequest(
      async () => validateHistoryWindow(await this.options.request({
        requestId: requestID,
        priority: 'prefetch',
        signal: abort.signal,
        lane: 'viewport',
        direction: windowStart < current.offset ? 'backward' : 'forward',
        anchor: current.anchor,
        snapshotId: current.snapshotId,
        offset: current.offset,
        targetOffset: windowStart,
        viewportRows: windowRows,
        windowRows,
      })),
      { priority: 'prefetch', signal: abort.signal },
    ).then(next => {
      if (this.disposed || epoch !== this.epoch || abort.signal.aborted) return;
      this.assertTransportGeneration(next);
      this.acceptLineage(next);
      this.frontier = next;
      this.cacheWindow(next);
    }).catch(error => {
      if (!abort.signal.aborted) {
        emitSemanticDebugTrace({ kind: 'history-prefetch-error', at: performance.now(), error });
      }
    }).finally(() => {
      if (this.prefetchAbort === abort) this.prefetchAbort = null;
      this.prefetchTask = null;
    });
    await this.prefetchTask;
  }

  private cacheExtraBytes(): number {
    return [...this.cache.values()]
      .filter(item => item.viewport !== this.visible)
      .reduce((sum, item) => sum + item.bytes, 0);
  }

  private isCompatible(viewport: SemanticHistoryViewport): boolean {
    return Boolean(this.latest
      && historyIdentityCompatible(viewport, this.latest)
      && viewport.contentEpoch === (this.latest.state.contentEpoch ?? 0)
      && viewport.geometryGeneration === this.latest.geometry.generation
      && (this.transportGeneration === null || viewport.transportGeneration === this.transportGeneration)
      && (viewport.lane ?? 'viewport') === 'viewport'
      && (this.historyAnchor === null || viewport.anchor === this.historyAnchor)
      && viewport.cols === this.latest.geometry.cols
      && viewport.rows === this.latest.geometry.rows
      && viewport.window !== true);
  }

  private isReusableViewport(viewport: SemanticHistoryViewport): boolean {
    return Boolean(this.latest
      && this.isCompatible(viewport)
      && historyViewportRangeCompatible(viewport, this.latest));
  }

  private isCompatibleWindow(viewport: SemanticHistoryViewport): boolean {
    return Boolean(this.latest
      && viewport.window === true
      && historyIdentityCompatible(viewport, this.latest)
      && viewport.contentEpoch === (this.latest.state.contentEpoch ?? 0)
      && viewport.geometryGeneration === this.latest.geometry.generation
      && (this.transportGeneration === null || viewport.transportGeneration === this.transportGeneration)
      && (viewport.lane ?? 'viewport') === 'viewport'
      && (this.historyAnchor === null || viewport.anchor === this.historyAnchor)
      && viewport.cols === this.latest.geometry.cols
      && viewport.rows >= this.latest.geometry.rows);
  }

  private isReusableWindow(viewport: SemanticHistoryViewport, target: number, rows: number): boolean {
    return Boolean(this.latest
      && this.isCompatibleWindow(viewport)
      && historyViewportRangeCompatible(viewport, this.latest)
      && this.windowCovers(viewport, target, rows)
      && viewport.revision <= this.latest.frame.history.revision);
  }

  private assertTransportGeneration(viewport: SemanticHistoryViewport): void {
    if (this.transportGeneration === null) {
      this.transportGeneration = viewport.transportGeneration;
      return;
    }
    if (viewport.transportGeneration !== this.transportGeneration) {
      throw new SemanticHistoryError('transport_stale', 'stale terminal transport generation');
    }
  }

  private resetHistory(projectLatest: boolean, error: Error | null = null): void {
    this.epoch += 1;
    this.cancelPrefetch();
    this.clearCache();
    this.frontier = null;
    this.visible = null;
    this.pendingProjection = false;
    this.desiredOffset = null;
    this.preferExactViewport = false;
    this.scrollDirection = 0;
    this.scrollBurstDirection = 0;
    this.scrollBurstRows = 0;
    this.scrollBurstAt = 0;
    this.estimatedHistoryRowBytes = 0;
    this.historyAnchor = null;
    this.error = error;
    if (projectLatest) this.options.renderer.project(null);
    this.emitState();
  }

  private shouldDisplayIntermediate(target: number, desiredOffset: number | null): boolean {
    if (this.pendingProjection || desiredOffset === null || this.visible === null) return false;
    const currentOffset = this.visible.offset;
    const minimum = Math.min(currentOffset, desiredOffset);
    const maximum = Math.max(currentOffset, desiredOffset);
    return target >= minimum && target <= maximum
      && Math.abs(desiredOffset - target) < Math.abs(desiredOffset - currentOffset);
  }

  private findCachedViewport(offset: number): SemanticHistoryViewport | null {
    for (const item of this.cache.values()) {
      if (!this.isReusableViewport(item.viewport)) continue;
      const remapped = remapViewportOffset(item.viewport, offset, this.latest);
      if (remapped) return remapped;
    }
    return null;
  }

  private findCachedWindow(offset: number, rows: number): SemanticHistoryViewport | null {
    if (rows <= 0) return null;
    let candidate: CachedViewport | null = null;
    for (const item of this.cache.values()) {
      if (this.isReusableWindow(item.viewport, offset, rows)
        && (!candidate || item.touched > candidate.touched)) candidate = item;
    }
    return candidate ? remapViewportOffset(candidate.viewport, offset, this.latest) : null;
  }

  private cacheWindow(viewport: SemanticHistoryViewport): void {
    if (viewport.window !== true) return;
    const observedRowBytes = estimateViewportBytes(viewport) / Math.max(1, viewport.rows);
    this.estimatedHistoryRowBytes = this.estimatedHistoryRowBytes === 0
      ? observedRowBytes
      : observedRowBytes > this.estimatedHistoryRowBytes
        ? observedRowBytes
        : this.estimatedHistoryRowBytes * 0.75 + observedRowBytes * 0.25;
    this.putCache(viewport);
    this.evictCache();
  }

  private putCache(viewport: SemanticHistoryViewport): void {
    if ((viewport.lane ?? 'viewport') !== 'viewport') {
      throw new SemanticHistoryError('malformed_snapshot', 'semantic history viewport belongs to another lane');
    }
    if (this.historyAnchor !== null && viewport.anchor !== this.historyAnchor) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history viewport lineage changed');
    }
    if (this.historyAnchor === null) this.historyAnchor = viewport.anchor;
    // Keep a sliced viewport separate from its source window. Reusing the same
    // key would replace the reusable window as soon as it is displayed once.
    const key = `${viewport.snapshotId}:${viewport.offset}:${viewport.window === true ? 'window' : 'viewport'}`;
    const previous = this.cache.get(key);
    this.touch += 1;
    if (previous?.viewport === viewport) {
      this.cache.set(key, { ...previous, touched: this.touch });
      return;
    }
    const bytes = estimateViewportBytes(viewport);
    const cells = viewport.cols * viewport.rows;
    if (previous) this.cacheBytes -= previous.bytes;
    const item = { viewport, touched: this.touch, bytes, cells };
    this.cache.set(key, item);
    this.cacheBytes += bytes;
  }

  private clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private removeCacheEntry(key: string): void {
    const item = this.cache.get(key);
    if (!item) return;
    this.cache.delete(key);
    this.cacheBytes -= item.bytes;
    if (this.frontier === item.viewport) this.frontier = null;
  }

  private acceptLineage(viewport: SemanticHistoryViewport, allowReplacement = false): void {
    if ((viewport.lane ?? 'viewport') !== 'viewport') {
      throw new SemanticHistoryError('malformed_snapshot', 'semantic history response belongs to another lane');
    }
    if (this.historyAnchor !== null && viewport.anchor !== this.historyAnchor) {
      this.clearCache();
      if (!allowReplacement) {
        throw new SemanticHistoryError('snapshot_superseded', 'semantic history frontier changed');
      }
    }
    this.historyAnchor = viewport.anchor;
  }

  private emitState(): void {
    this.options.onState?.(this.getState());
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function historyIdentityCompatible(
  viewport: SemanticHistoryViewport,
  latest: SemanticPresentation,
): boolean {
  const current = latest.frame.history;
  if (viewport.historyEpoch === undefined || current.historyEpoch === undefined
    || viewport.firstRowOrdinal === undefined || current.firstRowOrdinal === undefined) {
    return true;
  }
  if (viewport.historyEpoch !== current.historyEpoch) return false;
  const start = viewport.firstRowOrdinal + viewport.offset;
  const latestStart = current.firstRowOrdinal;
  const latestEnd = latestStart + current.totalRows;
  return start >= latestStart && start + viewport.rows <= latestEnd;
}

function historyViewportRangeCompatible(
  viewport: SemanticHistoryViewport,
  latest: SemanticPresentation,
): boolean {
  const current = latest.frame.history;
  if (viewport.firstRowOrdinal === undefined || current.firstRowOrdinal === undefined) {
    return viewport.offset + viewport.rows <= current.totalRows && viewport.totalRows <= current.totalRows;
  }
  const start = viewport.firstRowOrdinal + viewport.offset;
  const end = start + viewport.rows;
  const latestStart = current.firstRowOrdinal;
  return start >= latestStart && end <= latestStart + current.totalRows;
}

function remapViewportOffset(
  viewport: SemanticHistoryViewport,
  targetOffset: number,
  latest: SemanticPresentation | null,
): SemanticHistoryViewport | null {
  if (!latest) return null;
  const current = latest.frame.history;
  if (viewport.historyEpoch !== undefined && current.historyEpoch !== undefined
    && viewport.firstRowOrdinal !== undefined && current.firstRowOrdinal !== undefined) {
    const sourceOrdinal = viewport.firstRowOrdinal + viewport.offset;
    const targetOrdinal = current.firstRowOrdinal + targetOffset;
    if (viewport.window === true) {
      const windowStart = viewport.firstRowOrdinal + viewport.offset;
      if (targetOrdinal < windowStart || targetOrdinal + latest.geometry.rows > windowStart + viewport.rows) return null;
      const remappedOffset = windowStart - current.firstRowOrdinal;
      if (remappedOffset === viewport.offset
        && viewport.firstRowOrdinal === current.firstRowOrdinal
        && viewport.totalRows === current.totalRows) return viewport;
      const remapped = {
        ...viewport,
        offset: remappedOffset,
        totalRows: current.totalRows,
        screenStartOffset: current.totalRows - viewport.rows,
        firstRowOrdinal: current.firstRowOrdinal,
        screenStartRowOrdinal: current.firstRowOrdinal + current.totalRows - viewport.rows,
        frame: {
          ...viewport.frame,
          history: {
            ...viewport.frame.history,
            totalRows: current.totalRows,
            screenStartOffset: current.totalRows - viewport.rows,
            firstRowOrdinal: current.firstRowOrdinal,
            screenStartRowOrdinal: current.firstRowOrdinal + current.totalRows - viewport.rows,
          },
        },
      };
      return remapped;
    }
    if (sourceOrdinal !== targetOrdinal) return null;
    if (viewport.offset === targetOffset
      && viewport.firstRowOrdinal === current.firstRowOrdinal
      && viewport.totalRows === current.totalRows) return viewport;
    return {
      ...viewport,
      offset: targetOffset,
      totalRows: current.totalRows,
      screenStartOffset: current.totalRows - viewport.rows,
      firstRowOrdinal: current.firstRowOrdinal,
      screenStartRowOrdinal: current.firstRowOrdinal + current.totalRows - viewport.rows,
      frame: {
        ...viewport.frame,
        history: {
          ...viewport.frame.history,
          totalRows: current.totalRows,
          screenStartOffset: current.totalRows - viewport.rows,
          firstRowOrdinal: current.firstRowOrdinal,
          screenStartRowOrdinal: current.firstRowOrdinal + current.totalRows - viewport.rows,
        },
      },
    };
  }
  if (viewport.window === true) return viewport;
  if (viewport.offset !== targetOffset) return null;
  return viewport;
}

function createPendingViewport(
  presentation: SemanticPresentation,
  offset: number,
  transportGeneration: number,
  sequence: number,
): SemanticHistoryViewport {
  const source = presentation.frame;
  const totalRows = source.history.totalRows;
  const rows = source.height;
  const marker = `pending-${sequence}`;
  const skeletonRow = Array.from({ length: source.width }, () => ({
    text: ' ',
    width: 1,
    style: { background: 'indexed:8' },
  }));
  const frame: SemanticFrame = {
    ...source,
    rows: Array.from({ length: rows }, () => ({ cells: skeletonRow.map(cell => ({ ...cell, style: { ...cell.style } })) })),
    cursor: { ...source.cursor, visible: false },
    history: {
      revision: source.history.revision,
      totalRows,
      screenStartOffset: totalRows - rows,
      historyEpoch: source.history.historyEpoch,
      firstRowOrdinal: source.history.firstRowOrdinal,
      screenStartRowOrdinal: source.history.firstRowOrdinal === undefined
        ? source.history.screenStartRowOrdinal
        : source.history.firstRowOrdinal + totalRows - rows,
    },
    graphics: { generation: source.graphics.generation, images: [], placements: [] },
  };
  return {
    snapshotId: marker,
    lane: 'viewport',
    revision: source.history.revision,
    transportGeneration,
    contentEpoch: presentation.state.contentEpoch ?? 0,
    geometryGeneration: presentation.geometry.generation,
    cols: source.width,
    rows,
    anchor: marker,
    firstAvailable: marker,
    lastAvailable: marker,
    screenStart: marker,
    offset,
    totalRows,
    screenStartOffset: totalRows - rows,
    historyEpoch: source.history.historyEpoch,
    firstRowOrdinal: source.history.firstRowOrdinal,
    screenStartRowOrdinal: source.history.screenStartRowOrdinal,
    hasPrevious: offset > 0,
    hasNext: offset < totalRows - rows,
    frame,
  };
}

function isLegacyBoundaryTargetRejection(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const code = Number((cause as Error & { code?: unknown }).code);
  return code === 400 && cause.message.toLowerCase().includes('failed to read semantic history');
}

function isRecoverableHistoryLineageError(cause: unknown): cause is SemanticHistoryError {
  if (!(cause instanceof SemanticHistoryError)
    || (cause.kind !== 'anchor_invalid' && cause.kind !== 'snapshot_superseded')) return false;
  // The RPC adapter normally preserves the 409/412 code as `cause`, but a
  // transport implementation is allowed to surface the typed semantic error
  // directly. The semantic kind is the authoritative contract here; making
  // recovery depend on an adapter-specific numeric code exposed the user to
  // stale-anchor errors whenever that code was wrapped or omitted.
  const rpcCause = (cause as SemanticHistoryError & { cause?: unknown }).cause;
  // A local `snapshot_superseded` means two validated responses disagreed on
  // lineage and must remain a hard failure. Only an unwrapped anchor error is
  // safe to recover from without an adapter code: native history can expire
  // an anchor while the transport is still healthy.
  if (!rpcCause) return cause.kind === 'anchor_invalid';
  const code = rpcCause instanceof Error
    ? Number((rpcCause as Error & { code?: unknown }).code)
    : Number.NaN;
  return code === 409 || code === 412 || rpcCause instanceof SemanticHistoryError;
}

function estimateViewportBytes(viewport: SemanticHistoryViewport): number {
  return 256 + estimateFrameBytes(viewport.frame);
}

function estimateFrameBytes(frame: SemanticHistoryViewport['frame']): number {
  let bytes = 0;
  for (const row of frame.rows) {
    for (const cell of row.cells) bytes += 16 + cell.text.length * 2 + (cell.hyperlink?.length ?? 0) * 2;
  }
  return bytes;
}

function sliceHistoryWindow(
  window: SemanticHistoryViewport,
  offset: number,
  rows: number,
): SemanticHistoryViewport {
  if (window.window !== true || offset < window.offset || offset + rows > window.offset + window.rows) {
    throw new SemanticHistoryError('malformed_snapshot', 'semantic history window does not cover its target viewport');
  }
  const rowStart = offset - window.offset;
  const frame = window.frame;
  const end = rowStart + rows;
  const screenStartOffset = window.totalRows - rows;
  const cursorVisible = frame.cursor.visible && frame.cursor.y >= rowStart && frame.cursor.y < end;
  const placements = frame.graphics.placements
    .filter(placement => !placement.visible || (placement.viewportRow + placement.gridRows > rowStart && placement.viewportRow < end))
    .map(placement => ({ ...placement, viewportRow: placement.viewportRow - rowStart }));
  const slicedFrame = {
    ...frame,
    height: rows,
    rows: frame.rows.slice(rowStart, end),
    cursor: {
      ...frame.cursor,
      y: cursorVisible ? frame.cursor.y - rowStart : 0,
      visible: cursorVisible,
    },
    history: {
      revision: window.revision,
      totalRows: window.totalRows,
      screenStartOffset: window.totalRows - rows,
      historyEpoch: window.historyEpoch,
      firstRowOrdinal: window.firstRowOrdinal,
      screenStartRowOrdinal: window.firstRowOrdinal === undefined
        ? window.screenStartRowOrdinal
        : window.firstRowOrdinal + window.totalRows - rows,
    },
    graphics: { ...frame.graphics, placements },
  };
  return validateHistoryViewport({
    snapshotId: `${window.snapshotId}:${offset}`,
    lane: window.lane,
    revision: window.revision,
    transportGeneration: window.transportGeneration,
    contentEpoch: window.contentEpoch,
    geometryGeneration: window.geometryGeneration,
    cols: window.cols,
    rows,
    anchor: window.anchor,
    firstAvailable: window.firstAvailable,
    lastAvailable: window.lastAvailable,
    screenStart: window.screenStart,
    offset,
    totalRows: window.totalRows,
    screenStartOffset,
    historyEpoch: window.historyEpoch,
    firstRowOrdinal: window.firstRowOrdinal,
    screenStartRowOrdinal: window.firstRowOrdinal === undefined
      ? window.screenStartRowOrdinal
      : window.firstRowOrdinal + screenStartOffset,
    hasPrevious: offset > 0,
    hasNext: offset < screenStartOffset,
    frame: slicedFrame,
  });
}
