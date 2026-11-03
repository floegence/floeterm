import type { HistoryViewportController } from './HistoryViewportController.js';

export type HistoryScrollbarOptions = Readonly<{
  track: HTMLElement;
  thumb: HTMLElement;
  controller: Pick<HistoryViewportController, 'getState' | 'showOffset' | 'showLatest' | 'scrollByRows'>;
  /** Product may clear its search UI before explicit navigation. */
  onNavigate?: () => void;
  minThumbPx?: number;
  /** Return pointer users to their input surface; keyboard navigation keeps focus. */
  onPointerComplete?: () => void;
}>;

/** View-local interaction only; the history controller remains the position owner. */
export class HistoryScrollbar {
  private drag: { id: number; grabFraction: number } | null = null;
  private pending: number | null = null;
  private frame: number | null = null;
  private readonly resize: ResizeObserver;
  private readonly win: Window;
  private disposed = false;

  constructor(private readonly options: HistoryScrollbarOptions) {
    const { track, thumb } = options;
    this.win = track.ownerDocument.defaultView!;
    track.setAttribute('role', 'scrollbar');
    track.setAttribute('aria-orientation', 'vertical');
    track.tabIndex = 0;
    Object.assign(track.style, { cursor: 'default', userSelect: 'none', touchAction: 'none' });
    Object.assign(thumb.style, { cursor: 'grab', userSelect: 'none', touchAction: 'none' });
    track.addEventListener('pointerdown', this.down);
    track.addEventListener('pointermove', this.move);
    track.addEventListener('pointerup', this.up);
    track.addEventListener('pointercancel', this.cancel);
    track.addEventListener('lostpointercapture', this.cancel);
    track.addEventListener('keydown', this.key);
    track.addEventListener('click', this.click);
    this.win.addEventListener('blur', this.cancel);
    this.resize = new ResizeObserver(() => this.update());
    this.resize.observe(track);
    this.update();
  }

  update(): void {
    if (this.disposed) return;
    const { track, thumb, controller } = this.options;
    const state = controller.getState();
    const maximum = Math.max(0, state.screenStartOffset);
    track.hidden = maximum === 0;
    track.dataset.visible = maximum > 0 ? 'true' : 'false';
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', String(maximum));
    track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(maximum, state.offset))));
    track.setAttribute('aria-busy', String(state.busy));
    if (maximum === 0) this.cancel();
    const height = track.clientHeight;
    const rows = Math.max(1, state.totalRows - maximum);
    const size = Math.min(height, Math.max(this.options.minThumbPx ?? 28, height * rows / Math.max(rows, state.totalRows)));
    thumb.style.height = size + 'px';
    thumb.style.top = (maximum > 0 ? Math.min(maximum, state.offset) / maximum * (height - size) : 0) + 'px';
  }

  private navigate(offset: number): void {
    this.options.onNavigate?.();
    this.options.controller.showOffset(offset);
    this.update();
  }
  private down = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drag || this.options.track.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const { track, thumb, controller } = this.options;
    track.focus({ preventScroll: true });
    const state = controller.getState();
    const bounds = thumb.getBoundingClientRect();
    if (event.target === thumb || thumb.contains(event.target as Node)) {
      this.drag = { id: event.pointerId, grabFraction: (event.clientY - bounds.top) / Math.max(1, bounds.height) };
      track.setPointerCapture(event.pointerId);
      track.dataset.dragging = 'true';
      track.style.cursor = thumb.style.cursor = 'grabbing';
    } else {
      const rows = Math.max(1, state.totalRows - state.screenStartOffset);
      this.navigate(state.offset + (event.clientY < bounds.top ? -rows : rows));
      this.options.onPointerComplete?.();
    }
  };
  private move = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const { track, thumb, controller } = this.options;
    const maximum = controller.getState().screenStartOffset;
    const bounds = track.getBoundingClientRect();
    const thumbHeight = thumb.getBoundingClientRect().height;
    this.pending = Math.round(Math.max(0, Math.min(maximum,
      (event.clientY - bounds.top - drag.grabFraction * thumbHeight)
        / Math.max(1, bounds.height - thumbHeight) * maximum)));
    if (this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => { this.frame = null; this.flush(); });
  };
  private flush(): void {
    if (this.pending === null) return;
    const offset = this.pending;
    this.pending = null;
    this.navigate(offset);
  }
  private up = (event: PointerEvent): void => {
    if (this.drag?.id !== event.pointerId) return;
    this.move(event);
    this.flush();
    this.cancel();
    this.options.onPointerComplete?.();
  };
  private cancel = (): void => {
    const drag = this.drag;
    this.drag = null;
    this.pending = null;
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    const { track, thumb } = this.options;
    track.dataset.dragging = 'false';
    track.style.cursor = 'default';
    thumb.style.cursor = 'grab';
    if (drag && track.hasPointerCapture(drag.id)) track.releasePointerCapture(drag.id);
  };
  private click = (event: MouseEvent): void => { event.preventDefault(); event.stopPropagation(); };
  private key = (event: KeyboardEvent): void => {
    const state = this.options.controller.getState();
    const rows = Math.max(1, state.totalRows - state.screenStartOffset);
    const target: Record<string, number> = { ArrowUp: state.offset - 1, ArrowDown: state.offset + 1,
      PageUp: state.offset - rows, PageDown: state.offset + rows, Home: 0, End: state.screenStartOffset };
    if (!(event.key in target) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    this.navigate(target[event.key]!);
  };
  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.resize.disconnect();
    const { track } = this.options;
    track.removeEventListener('pointerdown', this.down);
    track.removeEventListener('pointermove', this.move);
    track.removeEventListener('pointerup', this.up);
    track.removeEventListener('pointercancel', this.cancel);
    track.removeEventListener('lostpointercapture', this.cancel);
    track.removeEventListener('keydown', this.key);
    track.removeEventListener('click', this.click);
    this.win.removeEventListener('blur', this.cancel);
  }
}
