import type { RendererSurface } from './RendererSurface.js';
import type {
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation.js';

export type HistoryViewportState = Readonly<{
  browsing: boolean;
  busy: boolean;
  offset: number;
  totalRows: number;
  screenStartOffset: number;
  error: Error | null;
}>;

export type HistoryViewportControllerOptions = Readonly<{
  renderer: Pick<RendererSurface, 'apply' | 'project' | 'getCellMetrics'>;
  request: (request: SemanticHistoryRequest) => Promise<SemanticHistoryViewport>;
  onState?: (state: HistoryViewportState) => void;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}>;

type CachedViewport = Readonly<{ viewport: SemanticHistoryViewport; touched: number }>;

const globalHistoryRequests = new class {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}();

export class HistoryViewportController {
  private latest: SemanticPresentation | null = null;
  private visible: SemanticHistoryViewport | null = null;
  private frontier: SemanticHistoryViewport | null = null;
  private readonly cache = new Map<number, CachedViewport>();
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
    if (invalidated) this.resetHistory(false);
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
    const cached = this.cache.get(target)?.viewport;
    if (cached && this.isCompatible(cached)) {
      this.desiredOffset = null;
      this.display(cached);
      this.schedulePrefetch(cached);
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
    if (!visible) this.prefetchOffset = null;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    if (this.wheelFrame !== null) this.cancelFrame(this.wheelFrame);
    this.wheelFrame = null;
    this.cache.clear();
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
        const cached = this.cache.get(target)?.viewport;
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
      else if (isStructuralInvalidation(this.error)) this.resetHistory(false);
    }
  }

  private async fetchOffset(target: number): Promise<SemanticHistoryViewport> {
    if (!this.latest) throw new Error('terminal history requires a live Presentation');
    const rows = this.latest.geometry.rows;
    let frontier = this.frontier;
    if (!frontier || !this.isCompatible(frontier)) {
      frontier = await globalHistoryRequests.run(() => this.options.request({
        direction: target === 0 ? 'start' : 'end',
        viewportRows: rows,
      }));
      this.assertTransportGeneration(frontier);
    }
    let current = frontier;
    if (!current) throw new Error('terminal history frontier is unavailable');
    let intended = target;
    while (current.offset !== intended) {
      if (this.desiredOffset !== null) intended = this.desiredOffset;
      const direction: SemanticHistoryRequest['direction'] = intended < current.offset ? 'backward' : 'forward';
      const scrollDeltaRows = Math.min(200, Math.abs(current.offset - intended));
      const anchor = current.anchor;
      const offset = current.offset;
      const next = await globalHistoryRequests.run(() => this.options.request({
        direction,
        anchor,
        offset,
        scrollDeltaRows,
        viewportRows: rows,
      }));
      this.assertTransportGeneration(next);
      if (next.offset === offset || (direction === 'backward' && next.offset > offset)
        || (direction === 'forward' && next.offset < offset)) {
        throw new Error('semantic history request did not advance toward its target');
      }
      current = next;
    }
    return current;
  }

  private display(viewport: SemanticHistoryViewport): void {
    this.visible = viewport;
    this.error = null;
    this.touch += 1;
    this.cache.set(viewport.offset, { viewport, touched: this.touch });
    this.options.renderer.project(viewport.frame);
    this.evictCache();
    this.emitState();
  }

  private cacheViewport(viewport: SemanticHistoryViewport): void {
    this.touch += 1;
    this.cache.set(viewport.offset, { viewport, touched: this.touch });
    this.evictCache();
  }

  private evictCache(): void {
    if (!this.latest) return;
    const viewportCells = this.latest.geometry.cols * this.latest.geometry.rows;
    const extraCells = Math.min(2 * viewportCells, 12_288);
    const maxEntries = 1 + Math.floor(extraCells / viewportCells);
    while (this.cache.size > maxEntries) {
      const candidates = [...this.cache.entries()]
        .filter(([, item]) => item.viewport !== this.visible && item.viewport !== this.frontier)
        .sort((left, right) => left[1].touched - right[1].touched);
      const oldest = candidates[0];
      if (!oldest) break;
      this.cache.delete(oldest[0]);
    }
  }

  private schedulePrefetch(viewport: SemanticHistoryViewport): void {
    if (!this.viewVisible || this.lastDirection === 0) return;
    const rows = viewport.rows;
    const target = clamp(viewport.offset + this.lastDirection * rows, 0, viewport.screenStartOffset);
    if (target === viewport.offset || this.cache.has(target)) return;
    this.prefetchOffset = target;
    if (!this.lane) this.startLane();
  }

  private isCompatible(viewport: SemanticHistoryViewport): boolean {
    return Boolean(this.latest
      && viewport.contentEpoch === (this.latest.state.contentEpoch ?? 0)
      && viewport.geometryGeneration === this.latest.geometry.generation
      && (this.transportGeneration === null || viewport.transportGeneration === this.transportGeneration)
      && viewport.cols === this.latest.geometry.cols
      && viewport.rows === this.latest.geometry.rows);
  }

  private assertTransportGeneration(viewport: SemanticHistoryViewport): void {
    if (this.transportGeneration === null) {
      this.transportGeneration = viewport.transportGeneration;
      return;
    }
    if (viewport.transportGeneration !== this.transportGeneration) {
      throw new Error('stale terminal transport generation');
    }
  }

  private resetHistory(projectLatest: boolean): void {
    this.epoch += 1;
    this.cache.clear();
    this.frontier = null;
    this.visible = null;
    this.desiredOffset = null;
    this.prefetchOffset = null;
    this.error = null;
    if (projectLatest) this.options.renderer.project(null);
    this.emitState();
  }

  private emitState(): void {
    this.options.onState?.(this.getState());
  }
}

function isStructuralInvalidation(error: Error): boolean {
  return /anchor is invalid|stale terminal transport generation|session is not attached|attachment.*invalid/iu.test(error.message);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
