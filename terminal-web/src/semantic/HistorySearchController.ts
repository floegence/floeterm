import type {
  SemanticFrame,
  SemanticHistoryRequest,
  SemanticHistoryViewport,
  SemanticPresentation,
} from './presentation.js';
import { SemanticHistoryError, validateHistoryViewport } from './presentation.js';
import { runSemanticHistoryRequest } from './historyRequestScheduler.js';
import type { SemanticTerminalSearchDecoration } from './RendererSurface.js';

export type SemanticHistorySearchMatch = Readonly<{
  searchId: number;
  matchId: string;
  viewportOffset: number;
  line: number;
  live: boolean;
  absoluteRow: number;
  startColumn: number;
  endColumnExclusive: number;
}>;

export type SemanticHistorySearchResult = Readonly<{
  query: string;
  matches: readonly SemanticHistorySearchMatch[];
  truncated: boolean;
}>;

export type HistorySearchControllerOptions = Readonly<{
  request: (request: SemanticHistoryRequest) => Promise<SemanticHistoryViewport>;
  maxMatches?: number;
}>;

export function semanticHistoryRowMatches(
  frame: SemanticFrame,
  line: number,
  query: string,
): ReadonlyArray<Readonly<{ startColumn: number; endColumnExclusive: number }>> {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const row = frame.rows[line];
  if (!row) return [];
  const segments: Array<{ start: number; end: number; column: number; width: number }> = [];
  let folded = '';
  row.cells.forEach((cell, column) => {
    if (cell.width === 0) return;
    const value = cell.text.toLocaleLowerCase();
    if (value.length === 0) return;
    const start = folded.length;
    folded += value;
    segments.push({ start, end: folded.length, column, width: Math.max(1, cell.width) });
  });
  const matches: Array<Readonly<{ startColumn: number; endColumnExclusive: number }>> = [];
  for (let index = folded.indexOf(needle); index >= 0; index = folded.indexOf(needle, index + Math.max(1, needle.length))) {
    const end = index + needle.length;
    const covered = segments.filter(segment => segment.end > index && segment.start < end);
    if (covered.length === 0) continue;
    const first = covered[0]!;
    const last = covered[covered.length - 1]!;
    matches.push(Object.freeze({
      startColumn: first.column,
      endColumnExclusive: last.column + last.width,
    }));
  }
  return matches;
}

export function semanticHistorySearchDecorationsForViewport(
  matches: readonly SemanticHistorySearchMatch[],
  viewportOffset: number,
  viewportRows: number,
  activeMatchId: string | null,
): ReadonlyArray<SemanticTerminalSearchDecoration> {
  return matches.flatMap(match => {
    const row = match.absoluteRow - viewportOffset;
    if (row < 0 || row >= viewportRows) return [];
    return [Object.freeze({
      row,
      startColumn: match.startColumn,
      endColumnExclusive: match.endColumnExclusive,
      active: match.matchId === activeMatchId,
      matchId: match.matchId,
    })];
  });
}

// Owns the isolated server-side search frontier. Search never borrows or
// replaces the viewport controller's navigation frontier.
export class HistorySearchController {
  private latest: SemanticPresentation | null = null;
  private frontier: SemanticHistoryViewport | null = null;
  private transportGeneration: number | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private searchId = 0;
  private disposed = false;

  constructor(private readonly options: HistorySearchControllerOptions) {}

  apply(presentation: SemanticPresentation): void {
    if (this.disposed) return;
    const invalidated = this.latest !== null && (
      (this.latest.state.contentEpoch ?? 0) !== (presentation.state.contentEpoch ?? 0)
      || this.latest.geometry.generation !== presentation.geometry.generation
      || this.latest.geometry.cols !== presentation.geometry.cols
      || this.latest.geometry.rows !== presentation.geometry.rows
    );
    this.latest = presentation;
    if (invalidated) this.reset();
  }

  setTransportGeneration(generation: number | null): void {
    if (this.disposed) return;
    if (generation !== null && (!Number.isSafeInteger(generation) || generation <= 0)) {
      throw new Error('terminal history transport generation is invalid');
    }
    if (this.transportGeneration === generation) return;
    this.transportGeneration = generation;
    this.reset();
  }

  search(query: string): Promise<SemanticHistorySearchResult> {
    const normalized = query.trim();
    const epoch = ++this.epoch;
    const searchId = ++this.searchId;
    const operation = this.operation.catch(() => undefined).then(async () => {
      if (this.disposed || epoch !== this.epoch || normalized.length === 0) {
        return Object.freeze({ query: normalized, matches: Object.freeze([]), truncated: false });
      }
      return await this.scan(normalized, epoch, searchId);
    });
    this.operation = operation;
    return operation;
  }

  resolveMatch(match: SemanticHistorySearchMatch): Promise<SemanticHistoryViewport | null> {
    const epoch = this.epoch;
    const operation = this.operation.catch(() => undefined).then(async () => {
      if (this.disposed || epoch !== this.epoch || match.searchId !== this.searchId) {
        throw new SemanticHistoryError('snapshot_superseded', 'semantic history search result is stale');
      }
      if (match.live) return null;
      const current = this.frontier;
      if (!current) throw new SemanticHistoryError('snapshot_superseded', 'semantic history search frontier is unavailable');
      if (current.offset === match.viewportOffset) return current;
      const direction: SemanticHistoryRequest['direction'] = match.viewportOffset < current.offset ? 'backward' : 'forward';
      const next = validateHistoryViewport(await runSemanticHistoryRequest(() => this.options.request({
        lane: 'search',
        direction,
        anchor: current.anchor,
        snapshotId: current.snapshotId,
        offset: current.offset,
        targetOffset: match.viewportOffset,
        viewportRows: current.rows,
      })));
      this.assertViewport(next, current.anchor);
      if (this.disposed || epoch !== this.epoch) {
        throw new SemanticHistoryError('snapshot_superseded', 'semantic history search was superseded');
      }
      this.frontier = next;
      return next;
    });
    this.operation = operation;
    return operation;
  }

  reset(): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.frontier = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.frontier = null;
  }

  private async scan(query: string, epoch: number, searchId: number): Promise<SemanticHistorySearchResult> {
    const latest = this.latest;
    if (!latest) throw new Error('terminal history search requires a live Presentation');
    const needle = query.toLocaleLowerCase();
    const matches: SemanticHistorySearchMatch[] = [];
    const seenRows = new Set<number>();
    const maxMatches = Math.max(1, Math.min(100_000, Math.trunc(this.options.maxMatches ?? 10_000)));
    let truncated = false;
    const collect = (frame: SemanticFrame, viewportOffset: number, live: boolean, upperBound: number): void => {
      for (let line = 0; line < frame.rows.length; line += 1) {
        const absoluteRow = viewportOffset + line;
        if (absoluteRow >= upperBound || seenRows.has(absoluteRow)) continue;
        seenRows.add(absoluteRow);
        const rowMatches = semanticHistoryRowMatches(frame, line, needle);
        for (const rowMatch of rowMatches) {
          if (matches.length >= maxMatches) {
            truncated = true;
            continue;
          }
          const matchId = `${searchId}:${absoluteRow}:${rowMatch.startColumn}:${rowMatch.endColumnExclusive}`;
          matches.push(Object.freeze({
            searchId,
            matchId,
            viewportOffset,
            line,
            live,
            absoluteRow,
            startColumn: rowMatch.startColumn,
            endColumnExclusive: rowMatch.endColumnExclusive,
          }));
        }
      }
    };

    let current = validateHistoryViewport(await runSemanticHistoryRequest(() => this.options.request({
      lane: 'search',
      direction: 'start',
      viewportRows: latest.geometry.rows,
    })));
    this.assertViewport(current);
    const anchor = current.anchor;
    const scrollbackEnd = current.screenStartOffset;
    collect(current.frame, current.offset, false, scrollbackEnd);
    const finalStart = Math.max(0, scrollbackEnd - current.rows);
    while (current.offset < finalStart) {
      if (this.disposed || epoch !== this.epoch) {
        throw new SemanticHistoryError('snapshot_superseded', 'semantic history search was superseded');
      }
      const targetOffset = Math.min(finalStart, current.offset + current.rows);
      const next = validateHistoryViewport(await runSemanticHistoryRequest(() => this.options.request({
        lane: 'search',
        direction: 'forward',
        anchor: current.anchor,
        snapshotId: current.snapshotId,
        offset: current.offset,
        targetOffset,
        viewportRows: current.rows,
      })));
      this.assertViewport(next, anchor);
      if (next.offset <= current.offset) {
        throw new SemanticHistoryError('malformed_snapshot', 'semantic history search did not advance');
      }
      current = next;
      collect(current.frame, current.offset, false, scrollbackEnd);
    }
    if (this.disposed || epoch !== this.epoch) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history search was superseded');
    }
    this.frontier = current;
    collect(latest.frame, latest.frame.history.screenStartOffset, true, Number.POSITIVE_INFINITY);
    return Object.freeze({ query, matches: Object.freeze(matches), truncated });
  }

  private assertViewport(viewport: SemanticHistoryViewport, anchor?: string): void {
    const latest = this.latest;
    if (!latest || viewport.lane !== 'search') {
      throw new SemanticHistoryError('malformed_snapshot', 'semantic history search response belongs to another lane');
    }
    if (anchor !== undefined && viewport.anchor !== anchor) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history search frontier changed');
    }
    if (viewport.contentEpoch !== (latest.state.contentEpoch ?? 0)
      || viewport.geometryGeneration !== latest.geometry.generation
      || viewport.cols !== latest.geometry.cols
      || viewport.rows !== latest.geometry.rows) {
      throw new SemanticHistoryError('snapshot_superseded', 'semantic history search geometry changed');
    }
    if (this.transportGeneration === null) this.transportGeneration = viewport.transportGeneration;
    else if (viewport.transportGeneration !== this.transportGeneration) {
      throw new SemanticHistoryError('transport_stale', 'stale terminal search transport generation');
    }
  }
}
