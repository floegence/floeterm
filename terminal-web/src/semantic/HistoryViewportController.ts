import type { RendererSurface } from './RendererSurface.js';
import type {
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation.js';
import {
  isStructuralSemanticHistoryError,
  SemanticHistoryError,
  validateHistoryViewport,
} from './presentation.js';
import { runSemanticHistoryRequest } from './historyRequestScheduler.js';

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
  renderer: Pick<RendererSurface, 'apply' | 'project' | 'getCellMetrics'>;
  request: (request: SemanticHistoryRequest) => Promise<SemanticHistoryViewport>;
  onState?: (state: HistoryViewportState) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}>;

type CachedViewport = Readonly<{
  viewport: SemanticHistoryViewport;
  touched: number;
  bytes: number;
  cells: number;
}>;
const MAX_HISTORY_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_GLOBAL_HISTORY_CACHE_BYTES = 16 * 1024 * 1024;

type GlobalCacheEntry = Readonly<{
  owner: number;
  key: string;
  bytes: number;
  touched: number;
  hidden: () => boolean;
  evictable: () => boolean;
  evict: () => void;
}>;

const globalHistoryCache = new class {
  private readonly entries = new Map<string, GlobalCacheEntry>();
  private nextOwner = 0;

  owner(): number {
    this.nextOwner += 1;
    return this.nextOwner;
  }

  put(entry: GlobalCacheEntry): void {
    this.entries.set(this.entryKey(entry.owner, entry.key), entry);
    this.enforce();
  }

  remove(owner: number, key: string): void {
    this.entries.delete(this.entryKey(owner, key));
  }

  clear(owner: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.owner === owner) this.entries.delete(key);
    }
  }

  private enforce(): void {
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > MAX_GLOBAL_HISTORY_CACHE_BYTES) {
      const candidate = [...this.entries.values()]
        .filter(entry => entry.evictable())
        .sort((left, right) => Number(right.hidden()) - Number(left.hidden()) || left.touched - right.touched)[0];
      if (!candidate) return;
      candidate.evict();
      total = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    }
  }

  private entryKey(owner: number, key: string): string {
    return `${owner}:${key}`;
  }
}();

export class HistoryViewportController {
  private readonly cacheOwner = globalHistoryCache.owner();
  private latest: SemanticPresentation | null = null;
  private visible: SemanticHistoryViewport | null = null;
  private frontier: SemanticHistoryViewport | null = null;
  private readonly cache = new Map<string, CachedViewport>();
  private cacheBytes = 0;
  private historyAnchor: string | null = null;
  private desiredOffset: number | null = null;
  private prefetchOffset: number | null = null;
  private lane: Promise<void> | null = null;
  private epoch = 0;
  private transportGeneration: number | null = null;
  private touch = 0;
  private disposed = false;
  private viewVisible = true;
  private error: Error | null = null;
  private wheelResidualRows = 0;
  private wheelFrame: number | null = null;
  private lastDirection: -1 | 0 | 1 = 0;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(private readonly options: HistoryViewportControllerOptions) {
    this.requestFrame = options.requestAnimationFrame
      ?? globalThis.requestAnimationFrame?.bind(globalThis)
      ?? (callback => globalThis.setTimeout(() => callback(performance.now()), 0) as unknown as number);
    this.cancelFrame = options.cancelAnimationFrame
      ?? globalThis.cancelAnimationFrame?.bind(globalThis)
      ?? (handle => globalThis.clearTimeout(handle));
  }

  apply(presentation: SemanticPresentation): void {
    if (this.disposed) return;
    const invalidated = this.latest !== null && (
      (this.latest.state.contentEpoch ?? 0) !== (presentation.state.contentEpoch ?? 0)
      || this.latest.geometry.generation !== presentation.geometry.generation
      || this.latest.geometry.cols !== presentation.geometry.cols
      || this.latest.geometry.rows !== presentation.geometry.rows
    );
    this.latest = presentation;
    this.options.renderer.apply(presentation);
    if (invalidated) this.resetHistory(true);
    this.emitState();
  }

  scrollByRows(deltaRows: number): void {
    if (this.disposed || !this.latest || !Number.isFinite(deltaRows)) return;
    const rows = Math.trunc(deltaRows);
    if (rows === 0) return;
    const current = this.desiredOffset ?? this.visible?.offset ?? this.latest.frame.history.screenStartOffset;
    const target = clamp(current + rows, 0, this.latest.frame.history.screenStartOffset);
    this.lastDirection = rows < 0 ? -1 : 1;
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
    if (this.wheelFrame !== null) return;
    this.wheelFrame = this.requestFrame(() => {
      this.wheelFrame = null;
      const wholeRows = this.wheelResidualRows < 0
        ? Math.ceil(this.wheelResidualRows)
        : Math.floor(this.wheelResidualRows);
      this.wheelResidualRows -= wholeRows;
      this.scrollByRows(wholeRows);
    });
  }

  showStart(): void {
    this.lastDirection = -1;
    this.showOffset(0);
  }

  showLatest(): void {
    if (!this.latest || this.disposed) return;
    this.desiredOffset = null;
    this.prefetchOffset = null;
    this.visible = null;
    this.frontier = null;
    this.clearCache();
    this.historyAnchor = null;
    this.error = null;
    this.options.renderer.project(null);
    this.emitState();
  }

  showOffset(offset: number): void {
    if (!this.latest || this.disposed || !Number.isFinite(offset)) return;
    const target = clamp(Math.trunc(offset), 0, this.latest.frame.history.screenStartOffset);
    if (target === this.latest.frame.history.screenStartOffset) {
      this.showLatest();
      return;
    }
    const cached = this.findCachedViewport(target);
    if (cached && this.isCompatible(cached)) {
      this.desiredOffset = null;
      this.display(cached);
      return;
    }
    this.desiredOffset = target;
    this.error = null;
    this.startLane();
    this.emitState();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.viewVisible === visible) return;
    this.viewVisible = visible;
    if (!visible) {
      this.prefetchOffset = null;
      this.evictCache(true);
    }
    else if (this.visible) this.schedulePrefetch(this.visible);
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
    this.prefetchOffset = null;
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
    if (this.wheelFrame !== null) this.cancelFrame(this.wheelFrame);
    this.wheelFrame = null;
    this.clearCache();
    this.visible = null;
    this.frontier = null;
    this.desiredOffset = null;
    this.prefetchOffset = null;
  }

  private startLane(): void {
    if (this.lane || this.disposed) return;
    const epoch = this.epoch;
    this.lane = this.runLane(epoch).finally(() => {
      this.lane = null;
      this.emitState();
      if (!this.disposed && (this.desiredOffset !== null || this.prefetchOffset !== null)) this.startLane();
    });
  }

  private async runLane(epoch: number): Promise<void> {
    let activeWasPrefetch = false;
    try {
      while (!this.disposed && this.epoch === epoch) {
        const target = this.desiredOffset ?? this.prefetchOffset;
        const isPrefetch = this.desiredOffset === null && this.prefetchOffset !== null;
        activeWasPrefetch = isPrefetch;
        if (target === null) return;
        if (isPrefetch) this.prefetchOffset = null;
        const cached = this.findCachedViewport(target);
        if (cached && this.isCompatible(cached)) {
          if (!isPrefetch && this.desiredOffset === target) {
            this.desiredOffset = null;
            this.display(cached);
          }
          continue;
        }
        const viewport = await this.fetchOffset(target);
        if (this.disposed || this.epoch !== epoch) return;
        this.frontier = viewport;
        this.cacheViewport(viewport);
        if (!isPrefetch && this.desiredOffset === target) {
          this.desiredOffset = null;
          this.display(viewport);
          this.schedulePrefetch(viewport);
        }
      }
    } catch (cause) {
      if (this.disposed || this.epoch !== epoch) return;
      this.error = cause instanceof Error ? cause : new Error(String(cause));
      this.frontier = null;
      this.desiredOffset = null;
      this.prefetchOffset = null;
      if (activeWasPrefetch) this.error = null;
      else if (isStructuralSemanticHistoryError(this.error)) this.resetHistory(true, this.error);
    }
  }

  private async fetchOffset(target: number): Promise<SemanticHistoryViewport> {
    if (!this.latest) throw new Error('terminal history requires a live Presentation');
    const rows = this.latest.geometry.rows;
    let frontier = this.frontier;
    if (!frontier || !this.isCompatible(frontier)) {
      frontier = validateHistoryViewport(await runSemanticHistoryRequest(() => this.options.request({
        lane: 'viewport',
        direction: target === 0 ? 'start' : 'end',
        viewportRows: rows,
      })));
      this.assertTransportGeneration(frontier);
      this.acceptLineage(frontier, true);
    }
    let current = frontier;
    if (!current) throw new Error('terminal history frontier is unavailable');
    const intended = this.desiredOffset ?? target;
    if (current.offset === intended) return current;
    const direction: SemanticHistoryRequest['direction'] = intended < current.offset ? 'backward' : 'forward';
    const scrollDeltaRows = Math.abs(current.offset - intended);
    if (scrollDeltaRows <= 0) return current;
    const offset = current.offset;
    const next = validateHistoryViewport(await runSemanticHistoryRequest(() => this.options.request({
      lane: 'viewport',
      direction,
      anchor: current.anchor,
      snapshotId: current.snapshotId,
      offset,
      targetOffset: intended,
      viewportRows: rows,
    })));
    this.assertTransportGeneration(next);
    this.acceptLineage(next);
    if (next.offset === offset || (direction === 'backward' && next.offset > offset)
      || (direction === 'forward' && next.offset < offset)) {
      throw new SemanticHistoryError('malformed_snapshot', 'semantic history request did not advance toward its target');
    }
    current = next;
    return current;
  }

  private display(viewport: SemanticHistoryViewport): void {
    this.visible = viewport;
    this.error = null;
    this.putCache(viewport);
    this.options.renderer.project(viewport.frame);
    this.evictCache();
    this.emitState();
  }

  private cacheViewport(viewport: SemanticHistoryViewport): void {
    this.putCache(viewport);
    this.evictCache();
  }

  private evictCache(dropHiddenExtras = false): void {
    const viewportCells = this.latest ? this.latest.geometry.cols * this.latest.geometry.rows : 0;
    const maxExtraCells = Math.min(2 * viewportCells, 12_288);
    for (;;) {
      const candidates = [...this.cache.entries()]
        .filter(([, item]) => item.viewport !== this.visible)
        .sort((left, right) => left[1].touched - right[1].touched);
      const extraBytes = candidates.reduce((sum, candidate) => sum + candidate[1].bytes, 0);
      const extraCells = candidates.reduce((sum, candidate) => sum + candidate[1].cells, 0);
      if (!dropHiddenExtras && extraBytes <= MAX_HISTORY_CACHE_BYTES && extraCells <= maxExtraCells) break;
      const oldest = candidates[0];
      if (!oldest) break;
      this.removeCacheEntry(oldest[0]);
    }
  }

  private schedulePrefetch(viewport: SemanticHistoryViewport): void {
    if (!this.viewVisible || this.lastDirection === 0) return;
    const rows = viewport.rows;
    const target = clamp(viewport.offset + this.lastDirection * rows, 0, viewport.screenStartOffset);
    if (target === viewport.offset || this.findCachedViewport(target)) return;
    this.prefetchOffset = target;
    if (!this.lane) this.startLane();
  }

  private isCompatible(viewport: SemanticHistoryViewport): boolean {
    return Boolean(this.latest
      && viewport.contentEpoch === (this.latest.state.contentEpoch ?? 0)
      && viewport.geometryGeneration === this.latest.geometry.generation
      && (this.transportGeneration === null || viewport.transportGeneration === this.transportGeneration)
      && (viewport.lane ?? 'viewport') === 'viewport'
      && (this.historyAnchor === null || viewport.anchor === this.historyAnchor)
      && viewport.cols === this.latest.geometry.cols
      && viewport.rows === this.latest.geometry.rows);
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
    this.clearCache();
    this.frontier = null;
    this.visible = null;
    this.desiredOffset = null;
    this.prefetchOffset = null;
    this.historyAnchor = null;
    this.error = error;
    if (projectLatest) this.options.renderer.project(null);
    this.emitState();
  }

  private findCachedViewport(offset: number): SemanticHistoryViewport | null {
    for (const item of this.cache.values()) {
      if (item.viewport.offset === offset && this.isCompatible(item.viewport)) return item.viewport;
    }
    return null;
  }

  private putCache(viewport: SemanticHistoryViewport): void {
    if ((viewport.lane ?? 'viewport') !== 'viewport') {
      throw new SemanticHistoryError('malformed_snapshot', 'semantic history viewport belongs to another lane');
    }
    if (this.historyAnchor !== null && viewport.anchor !== this.historyAnchor) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history viewport lineage changed');
    }
    if (this.historyAnchor === null) this.historyAnchor = viewport.anchor;
    const key = `${viewport.snapshotId}:${viewport.offset}`;
    const bytes = estimateViewportBytes(viewport);
    const cells = viewport.cols * viewport.rows;
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes;
    this.touch += 1;
    const item = { viewport, touched: this.touch, bytes, cells };
    this.cache.set(key, item);
    this.cacheBytes += bytes;
    globalHistoryCache.put({
      owner: this.cacheOwner,
      key,
      bytes,
      touched: item.touched,
      hidden: () => !this.viewVisible,
      evictable: () => {
        const current = this.cache.get(key)?.viewport;
        return Boolean(current && current !== this.visible);
      },
      evict: () => this.removeCacheEntry(key),
    });
  }

  private clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
    globalHistoryCache.clear(this.cacheOwner);
  }

  private removeCacheEntry(key: string): void {
    const item = this.cache.get(key);
    if (!item) return;
    this.cache.delete(key);
    this.cacheBytes -= item.bytes;
    if (this.frontier === item.viewport) this.frontier = null;
    globalHistoryCache.remove(this.cacheOwner, key);
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

function estimateViewportBytes(viewport: SemanticHistoryViewport): number {
  let bytes = 256;
  for (const row of viewport.frame.rows) {
    for (const cell of row.cells) bytes += 16 + cell.text.length * 2 + (cell.hyperlink?.length ?? 0) * 2;
  }
  return bytes;
}
