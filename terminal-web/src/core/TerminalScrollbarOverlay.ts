import type {
  TerminalScrollbarOptions,
  TerminalScrollbarVisibility,
} from '../types.js';
import {
  deriveContrastingThemeColor,
  formatThemeColor,
  parseThemeColor,
} from '../utils/themeColor.js';

export const TERMINAL_SCROLLBAR_AUTO_HIDE_DELAY_MS = 1_200;
export const TERMINAL_SCROLLBAR_FADE_DURATION_MS = 160;
export const TERMINAL_SCROLLBAR_HIT_WIDTH_PX = 12;

const DEFAULT_SCROLLBAR_OPTIONS: Required<TerminalScrollbarOptions> = {
  visibility: 'auto',
  minThumbPx: 24,
  ariaLabel: 'Terminal scrollback',
};

export interface TerminalScrollbarRuntime {
  readonly rows: number;
  getScrollbackLength(): number;
  getViewportY(): number;
  isAlternateScreen(): boolean;
  scrollToLine(line: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
  scrollLines(amount: number): void;
  scrollPages(amount: number): void;
  focusTerminal(): void;
}

function normalizeVisibility(value: unknown): TerminalScrollbarVisibility {
  if (value === 'auto' || value === 'persistent' || value === 'hidden') {
    return value;
  }
  throw new Error('Terminal scrollbar visibility must be auto, persistent, or hidden');
}

function normalizeMinThumbPx(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 16) {
    throw new Error('Terminal scrollbar minThumbPx must be a finite number of at least 16');
  }
  return value;
}

function normalizeAriaLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Terminal scrollbar ariaLabel must be a non-empty string');
  }
  return value.trim();
}

export function normalizeTerminalScrollbarOptions(
  value: TerminalScrollbarOptions | undefined,
): Required<TerminalScrollbarOptions> {
  if (value !== undefined) {
    const prototype = typeof value === 'object' && value !== null
      ? Object.getPrototypeOf(value)
      : null;
    if (
      typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || (prototype !== Object.prototype && prototype !== null)
    ) {
      throw new Error('Terminal scrollbar options must be a plain object');
    }
  }
  const source = value ?? {};
  return {
    visibility: normalizeVisibility(source.visibility ?? DEFAULT_SCROLLBAR_OPTIONS.visibility),
    minThumbPx: normalizeMinThumbPx(source.minThumbPx ?? DEFAULT_SCROLLBAR_OPTIONS.minThumbPx),
    ariaLabel: normalizeAriaLabel(source.ariaLabel ?? DEFAULT_SCROLLBAR_OPTIONS.ariaLabel),
  };
}

function readTrackHeight(host: HTMLElement): number {
  const clientHeight = Number(host.clientHeight);
  if (Number.isFinite(clientHeight) && clientHeight >= 0) {
    return clientHeight;
  }
  const rectHeight = Number(host.getBoundingClientRect().height);
  return Number.isFinite(rectHeight) && rectHeight > 0 ? rectHeight : 0;
}

function clientYToTrackY(host: HTMLElement, clientY: number): number {
  const rect = host.getBoundingClientRect();
  const trackHeight = readTrackHeight(host);
  if (trackHeight <= 0 || !Number.isFinite(rect.height) || rect.height <= 0) return 0;
  return (clientY - rect.top) * (trackHeight / rect.height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function cssPx(value: number): string {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))}px`;
}

function scrollbarThumbColors(background: string | undefined): {
  idle: string;
  hover: string;
  active: string;
} {
  const parsed = parseThemeColor(background) ?? { r: 17, g: 24, b: 39 };
  return {
    idle: formatThemeColor(deriveContrastingThemeColor(parsed, 3)),
    hover: formatThemeColor(deriveContrastingThemeColor(parsed, 4.5)),
    active: formatThemeColor(deriveContrastingThemeColor(parsed, 7)),
  };
}

export class TerminalScrollbarOverlay {
  private readonly root: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly styleElement: HTMLStyleElement;
  private options: Required<TerminalScrollbarOptions>;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private autoVisible = false;
  private hovered = false;
  private focused = false;
  private dragging = false;
  private dragPointerId: number | null = null;
  private dragCaptureElement: Element | null = null;
  private dragOffsetPx = 0;
  private disposed = false;
  private readonly coarseQuery: MediaQueryList | null;
  private readonly fineQuery: MediaQueryList | null;
  private readonly onPointerMediaChange = () => {
    this.cancelInteraction(false);
    this.clearFadeTimer();
    this.hovered = false;
    this.autoVisible = false;
    this.sync();
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly runtime: TerminalScrollbarRuntime,
    options?: TerminalScrollbarOptions,
    controlledElementId?: string,
  ) {
    this.options = normalizeTerminalScrollbarOptions(options);
    this.root = host.ownerDocument.createElement('div');
    this.root.dataset.floetermScrollbar = '';
    this.root.dataset.visible = 'false';
    this.root.setAttribute('role', 'scrollbar');
    this.root.setAttribute('aria-orientation', 'vertical');
    this.root.setAttribute('aria-valuemin', '0');
    this.root.setAttribute('aria-label', this.options.ariaLabel);
    if (controlledElementId) this.root.setAttribute('aria-controls', controlledElementId);
    this.root.tabIndex = -1;
    Object.assign(this.root.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      bottom: '0',
      width: `${TERMINAL_SCROLLBAR_HIT_WIDTH_PX}px`,
      zIndex: '6',
      outline: 'none',
      pointerEvents: 'none',
      opacity: '0',
      transition: `opacity ${TERMINAL_SCROLLBAR_FADE_DURATION_MS}ms ease`,
    });

    this.thumb = host.ownerDocument.createElement('div');
    this.thumb.dataset.floetermScrollbarThumb = '';
    Object.assign(this.thumb.style, {
      position: 'absolute',
      top: '0',
      right: '3px',
      width: '5px',
      minHeight: '0',
      borderRadius: '3px',
      background: 'var(--floeterm-scrollbar-thumb-idle, rgb(209, 213, 219))',
      transform: 'translateY(0px)',
      willChange: 'transform',
    });
    this.root.appendChild(this.thumb);
    this.styleElement = host.ownerDocument.createElement('style');
    this.styleElement.dataset.floetermScrollbarStyle = '';
    this.styleElement.textContent = `
[data-floeterm-scrollbar]:focus-visible {
  outline: 2px solid var(--floeterm-scrollbar-thumb-active, CanvasText) !important;
  outline-offset: -2px;
}
[data-floeterm-scrollbar][data-hovered="true"] [data-floeterm-scrollbar-thumb],
[data-floeterm-scrollbar]:focus-visible [data-floeterm-scrollbar-thumb] {
  background: var(--floeterm-scrollbar-thumb-hover, rgb(156, 163, 175));
}
[data-floeterm-scrollbar][data-dragging="true"] [data-floeterm-scrollbar-thumb] {
  background: var(--floeterm-scrollbar-thumb-active, rgb(107, 114, 128));
}
@media (prefers-reduced-motion: reduce) {
  [data-floeterm-scrollbar] { transition: none !important; }
}
@media (forced-colors: active) {
  [data-floeterm-scrollbar] {
    forced-color-adjust: auto;
    outline-color: Highlight !important;
  }
  [data-floeterm-scrollbar-thumb] {
    background: Highlight !important;
    border: 1px solid ButtonText;
  }
}`;
    this.host.appendChild(this.styleElement);
    this.host.appendChild(this.root);

    const view = host.ownerDocument.defaultView;
    this.coarseQuery = view?.matchMedia?.('(any-pointer: coarse)') ?? null;
    this.fineQuery = view?.matchMedia?.('(any-pointer: fine)') ?? null;
    this.coarseQuery?.addEventListener?.('change', this.onPointerMediaChange);
    this.fineQuery?.addEventListener?.('change', this.onPointerMediaChange);

    this.root.addEventListener('focus', this.onFocus);
    this.root.addEventListener('blur', this.onBlur);
    this.root.addEventListener('keydown', this.onKeyDown);
    this.host.addEventListener('pointerdown', this.onPointerDown, true);
    this.host.addEventListener('pointermove', this.onPointerMove, true);
    this.host.addEventListener('pointerleave', this.onPointerLeave);
    this.host.addEventListener('pointerup', this.onPointerEnd, true);
    this.host.addEventListener('pointercancel', this.onPointerEnd, true);
    this.host.addEventListener('lostpointercapture', this.onLostPointerCapture, true);
    this.host.addEventListener('wheel', this.onWheelActivity, true);
    this.sync();
  }

  setOptions(options: Partial<TerminalScrollbarOptions>): void {
    normalizeTerminalScrollbarOptions(options);
    const next = normalizeTerminalScrollbarOptions({ ...this.options, ...options });
    const visibilityChanged = next.visibility !== this.options.visibility;
    this.options = next;
    this.root.setAttribute('aria-label', next.ariaLabel);
    if (visibilityChanged) {
      this.cancelInteraction(false);
      this.clearFadeTimer();
      this.hovered = false;
      this.autoVisible = false;
      if (next.visibility === 'hidden') this.releaseScrollbarFocus();
    }
    this.sync();
  }

  setBackgroundColor(background: string | undefined): void {
    const colors = scrollbarThumbColors(background);
    this.root.style.setProperty('--floeterm-scrollbar-thumb-idle', colors.idle);
    this.root.style.setProperty('--floeterm-scrollbar-thumb-hover', colors.hover);
    this.root.style.setProperty('--floeterm-scrollbar-thumb-active', colors.active);
    this.updateThumbAppearance();
  }

  reveal(): void {
    if (this.disposed || this.effectiveVisibility() === 'hidden') return;
    this.autoVisible = true;
    this.updateVisibility();
    this.scheduleAutoHide();
  }

  sync(): void {
    if (this.disposed) return;
    const scrollbackLength = Math.max(0, Math.floor(Number(this.runtime.getScrollbackLength()) || 0));
    const alternate = this.runtime.isAlternateScreen();
    const trackHeight = Math.max(0, readTrackHeight(this.host));
    const unavailable = scrollbackLength === 0
      || trackHeight === 0
      || alternate
      || this.effectiveVisibility() === 'hidden';

    if (unavailable) {
      this.cancelInteraction(false);
      this.clearFadeTimer();
      this.hovered = false;
      this.autoVisible = false;
      this.releaseScrollbarFocus();
      this.thumb.style.height = '0px';
      this.thumb.style.transform = 'translateY(0px)';
      this.root.hidden = true;
      this.root.tabIndex = -1;
      this.root.setAttribute('aria-hidden', 'true');
      this.root.dataset.visible = 'false';
      this.root.dataset.hovered = 'false';
      this.root.style.opacity = '0';
      return;
    }

    const rows = Math.max(1, Math.floor(Number(this.runtime.rows) || 1));
    const viewportY = clamp(Number(this.runtime.getViewportY()) || 0, 0, scrollbackLength);
    const naturalValue = scrollbackLength - viewportY;
    const proportionalHeight = trackHeight * (rows / (rows + scrollbackLength));
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(16, this.options.minThumbPx, proportionalHeight),
    );
    const travel = Math.max(0, trackHeight - thumbHeight);
    const top = scrollbackLength === 0 ? 0 : travel * (naturalValue / scrollbackLength);

    this.root.setAttribute('aria-valuemax', String(scrollbackLength));
    this.root.setAttribute('aria-valuenow', String(Math.round(naturalValue)));
    this.thumb.style.height = cssPx(thumbHeight);
    this.thumb.style.transform = `translateY(${cssPx(top)})`;
    this.root.hidden = false;
    this.root.tabIndex = 0;
    this.root.removeAttribute('aria-hidden');
    this.updateVisibility();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelInteraction(false);
    this.clearFadeTimer();
    this.coarseQuery?.removeEventListener?.('change', this.onPointerMediaChange);
    this.fineQuery?.removeEventListener?.('change', this.onPointerMediaChange);
    this.root.removeEventListener('focus', this.onFocus);
    this.root.removeEventListener('blur', this.onBlur);
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.host.removeEventListener('pointerdown', this.onPointerDown, true);
    this.host.removeEventListener('pointermove', this.onPointerMove, true);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
    this.host.removeEventListener('pointerup', this.onPointerEnd, true);
    this.host.removeEventListener('pointercancel', this.onPointerEnd, true);
    this.host.removeEventListener('lostpointercapture', this.onLostPointerCapture, true);
    this.host.removeEventListener('wheel', this.onWheelActivity, true);
    this.root.remove();
    this.styleElement.remove();
  }

  private effectiveVisibility(): TerminalScrollbarVisibility {
    if (this.options.visibility === 'persistent' && this.isPureCoarsePointer()) {
      return 'auto';
    }
    return this.options.visibility;
  }

  private isPureCoarsePointer(): boolean {
    return Boolean(this.coarseQuery?.matches && !this.fineQuery?.matches);
  }

  private updateVisibility(): void {
    if (this.root.hidden) return;
    const persistent = this.effectiveVisibility() === 'persistent';
    const visible = persistent || this.autoVisible || this.hovered || this.focused || this.dragging;
    this.root.dataset.visible = String(visible);
    this.root.dataset.hovered = String(this.hovered);
    this.root.dataset.dragging = String(this.dragging);
    this.root.style.opacity = visible ? '1' : '0';
    this.updateThumbAppearance();
  }

  private updateThumbAppearance(): void {
    const variable = this.dragging
      ? '--floeterm-scrollbar-thumb-active'
      : this.hovered || this.focused
        ? '--floeterm-scrollbar-thumb-hover'
        : '--floeterm-scrollbar-thumb-idle';
    this.thumb.style.background = `var(${variable}, rgb(209, 213, 219))`;
  }

  private scheduleAutoHide(): void {
    this.clearFadeTimer();
    if (this.effectiveVisibility() !== 'auto' || this.hovered || this.focused || this.dragging) return;
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      this.autoVisible = false;
      this.updateVisibility();
    }, TERMINAL_SCROLLBAR_AUTO_HIDE_DELAY_MS);
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer === null) return;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
  }

  private readonly onFocus = () => {
    this.focused = true;
    this.clearFadeTimer();
    this.updateVisibility();
  };

  private readonly onBlur = () => {
    this.focused = false;
    this.scheduleAutoHide();
    this.updateVisibility();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    let handled = true;
    switch (event.key) {
      case 'ArrowUp':
        this.runtime.scrollLines(-1);
        break;
      case 'ArrowDown':
        this.runtime.scrollLines(1);
        break;
      case 'PageUp':
        this.runtime.scrollPages(-1);
        break;
      case 'PageDown':
        this.runtime.scrollPages(1);
        break;
      case 'Home':
        this.runtime.scrollToTop();
        break;
      case 'End':
        this.runtime.scrollToBottom();
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    this.reveal();
    this.sync();
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (
      event.pointerType === 'touch'
      || this.isPureCoarsePointer()
      || this.root.hidden
      || !this.isWithinHitRail(event.clientX, event.clientY)
    ) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragging = true;
    this.dragPointerId = event.pointerId;
    const thumbTop = Number.parseFloat(this.thumb.style.transform.replace(/[^\d.-]/g, '')) || 0;
    const thumbHeight = Number.parseFloat(this.thumb.style.height) || 0;
    const localY = clientYToTrackY(this.host, event.clientY);
    if (localY >= thumbTop && localY <= thumbTop + thumbHeight) {
      this.dragOffsetPx = localY - thumbTop;
    } else {
      this.dragOffsetPx = thumbHeight / 2;
      this.scrollFromPointer(localY);
    }
    const captureElement = event.target instanceof Element ? event.target : this.host;
    try {
      captureElement.setPointerCapture?.(event.pointerId);
      this.dragCaptureElement = captureElement;
    } catch {
      // Synthetic pointer events do not always have an active browser pointer.
      this.dragCaptureElement = null;
    }
    this.reveal();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || this.isPureCoarsePointer()) return;
    if (!this.dragging) {
      const hovered = !this.root.hidden && this.isWithinHitRail(event.clientX, event.clientY);
      if (hovered === this.hovered) return;
      this.hovered = hovered;
      if (hovered) {
        this.clearFadeTimer();
      } else {
        this.scheduleAutoHide();
      }
      this.updateVisibility();
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const localY = clientYToTrackY(this.host, event.clientY);
    this.scrollFromPointer(localY);
  };

  private readonly onPointerEnd = (event: PointerEvent) => {
    if (!this.dragging || (this.dragPointerId !== null && event.pointerId !== this.dragPointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    const hovered = event.type === 'pointerup'
      && event.pointerType !== 'touch'
      && !this.isPureCoarsePointer()
      && !this.root.hidden
      && this.isWithinHitRail(event.clientX, event.clientY);
    this.cancelInteraction(true);
    this.hovered = hovered;
    this.scheduleAutoHide();
    this.updateVisibility();
  };

  private readonly onPointerLeave = () => {
    if (this.dragging || !this.hovered) return;
    this.hovered = false;
    this.scheduleAutoHide();
    this.updateVisibility();
  };

  private readonly onLostPointerCapture = (event: PointerEvent) => {
    if (!this.dragging || (this.dragPointerId !== null && event.pointerId !== this.dragPointerId)) return;
    this.cancelInteraction(true);
    this.hovered = false;
    this.scheduleAutoHide();
    this.updateVisibility();
  };

  private cancelInteraction(restoreFocus: boolean): void {
    const pointerId = this.dragPointerId;
    const captureElement = this.dragCaptureElement;
    this.dragging = false;
    this.dragPointerId = null;
    this.dragCaptureElement = null;
    this.dragOffsetPx = 0;
    this.root.dataset.dragging = 'false';
    if (pointerId !== null) {
      try {
        if (captureElement?.hasPointerCapture?.(pointerId)) {
          captureElement.releasePointerCapture?.(pointerId);
        }
      } catch {
        // The browser may already have released capture during lifecycle changes.
      }
    }
    if (restoreFocus) this.runtime.focusTerminal();
  }

  private releaseScrollbarFocus(): void {
    if (this.host.ownerDocument.activeElement === this.root) {
      this.root.blur();
      this.runtime.focusTerminal();
    }
    this.focused = false;
  }

  private isWithinHitRail(clientX: number, clientY: number): boolean {
    const rect = this.host.getBoundingClientRect();
    return clientX >= rect.right - TERMINAL_SCROLLBAR_HIT_WIDTH_PX
      && clientX <= rect.right
      && clientY >= rect.top
      && clientY <= rect.bottom;
  }

  private scrollFromPointer(localY: number): void {
    const max = Math.max(0, Math.floor(Number(this.runtime.getScrollbackLength()) || 0));
    const trackHeight = Math.max(0, readTrackHeight(this.host));
    const thumbHeight = Number.parseFloat(this.thumb.style.height) || 0;
    const travel = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = clamp(localY - this.dragOffsetPx, 0, travel);
    const naturalValue = travel === 0 ? max : Math.round((thumbTop / travel) * max);
    this.runtime.scrollToLine(max - naturalValue);
    this.sync();
  }

  private readonly onWheelActivity = () => {
    if (this.root.hidden) return;
    this.reveal();
  };
}
