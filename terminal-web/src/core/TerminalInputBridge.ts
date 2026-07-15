import type {
  Logger,
  TerminalCopySelectionResult,
  TerminalCopySelectionSource,
  TerminalFocusOptions,
} from '../types.js';
import { noopLogger } from '../utils/logger.js';

type input_suppression_token =
  | { kind: 'linebreak' }
  | { kind: 'backspace' };

const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';
const TERMINAL_CONTENTEDITABLE_INPUT_SELECTOR = '[contenteditable="true"][aria-label="Terminal input"]';

const MODIFIER_ONLY_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Meta',
  'NumLock',
  'ScrollLock',
  'Shift'
]);

const isPlainPrintableKey = (event: KeyboardEvent): boolean => {
  if ((event.ctrlKey && !event.altKey) || (event.altKey && !event.ctrlKey) || event.metaKey) {
    return false;
  }

  return event.key.length === 1;
};

const isPrimaryCopyShortcut = (event: KeyboardEvent): boolean => {
  if (event.altKey || event.shiftKey) {
    return false;
  }

  const usesPrimaryModifier =
    (event.metaKey && !event.ctrlKey) ||
    (event.ctrlKey && !event.metaKey);

  return usesPrimaryModifier && event.key.toLowerCase() === 'c';
};

const createSuppressionTokenFromKeydown = (event: KeyboardEvent): input_suppression_token | null => {
  if (event.key === 'Enter') return { kind: 'linebreak' };
  if (event.key === 'Backspace') return { kind: 'backspace' };
  return null;
};

const mapKeydownToTerminalData = (event: KeyboardEvent): string | null => {
  if (event.key === 'Enter') return '\r';
  if (event.key === 'Backspace') return '\x7f';
  return null;
};

const normalizeTerminalFocusOptions = (options?: TerminalFocusOptions | FocusOptions): FocusOptions => ({
  ...options,
  preventScroll: options?.preventScroll ?? true,
});

const focusTerminalElement = (element: HTMLElement, options?: TerminalFocusOptions): void => {
  element.focus(normalizeTerminalFocusOptions(options));
};

type terminal_focus_host_patch = {
  originalFocus: typeof HTMLElement.prototype.focus;
  originalDescriptor?: PropertyDescriptor;
  wrappedFocus: typeof HTMLElement.prototype.focus;
  references: number;
};

const terminalFocusHostPatches = new WeakMap<HTMLElement, terminal_focus_host_patch>();

const retainTerminalFocusHostPatch = (host: HTMLElement): (() => void) => {
  const existingPatch = terminalFocusHostPatches.get(host);
  if (existingPatch) {
    existingPatch.references += 1;
    return () => {
      releaseTerminalFocusHostPatch(host, existingPatch);
    };
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(host, 'focus');
  const originalFocus = host.focus;
  const patch: terminal_focus_host_patch = {
    originalFocus,
    originalDescriptor,
    wrappedFocus: ((options?: FocusOptions) => {
      originalFocus.call(host, normalizeTerminalFocusOptions(options));
    }) as typeof host.focus,
    references: 1,
  };
  terminalFocusHostPatches.set(host, patch);
  host.focus = patch.wrappedFocus;
  return () => {
    releaseTerminalFocusHostPatch(host, patch);
  };
};

const releaseTerminalFocusHostPatch = (host: HTMLElement, patch: terminal_focus_host_patch): void => {
  const currentPatch = terminalFocusHostPatches.get(host);
  if (currentPatch !== patch) {
    return;
  }

  patch.references -= 1;
  if (patch.references > 0) {
    return;
  }

  terminalFocusHostPatches.delete(host);
  if (host.focus === patch.wrappedFocus) {
    if (patch.originalDescriptor) {
      Object.defineProperty(host, 'focus', patch.originalDescriptor);
    } else {
      delete (host as { focus?: typeof host.focus }).focus;
    }
  }
};

const matchesBeforeInputSuppression = (token: input_suppression_token, event: InputEvent): boolean => {
  if (token.kind === 'linebreak') {
    return event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph';
  }
  return event.inputType === 'deleteContentBackward';
};

const matchesInputSuppression = (token: input_suppression_token, value: string): boolean => {
  return value.length === 0;
};

const mapBeforeInputToTerminalData = (event: InputEvent): string | null => {
  switch (event.inputType) {
    case 'insertText':
      return String(event.data ?? '');
    case 'insertLineBreak':
    case 'insertParagraph':
      return '\r';
    case 'deleteContentBackward':
      return '\x7f';
    default:
      return null;
  }
};

const cloneKeyboardEventInit = (event: KeyboardEvent): KeyboardEventInit => ({
  key: event.key,
  code: event.code,
  location: event.location,
  repeat: event.repeat,
  ctrlKey: event.ctrlKey,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  metaKey: event.metaKey,
  bubbles: true,
  cancelable: true,
  composed: true,
});

const isEditableTarget = (target: EventTarget | null): target is HTMLElement => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.matches('input, select, textarea, [contenteditable], [contenteditable="true"]');
};

type terminal_document_shortcut_coordinator = {
  activeBridge: TerminalInputBridge | null;
  bridges: Set<TerminalInputBridge>;
  pointerDownListener: (event: Event) => void;
  focusInListener: (event: FocusEvent) => void;
  keydownListener: (event: KeyboardEvent) => void;
  copyListener: (event: ClipboardEvent) => void;
};

const documentShortcutCoordinators = new WeakMap<Document, terminal_document_shortcut_coordinator>();

export const resolveTerminalInputElement = (container: HTMLElement): HTMLTextAreaElement | null => {
  const direct = container.querySelector(TERMINAL_INPUT_SELECTOR);
  if (direct instanceof HTMLTextAreaElement) {
    return direct;
  }

  const fallback = container.querySelector('textarea');
  return fallback instanceof HTMLTextAreaElement ? fallback : null;
};

export class TerminalInputBridge {
  private isComposing = false;
  private ignoreNextInput = false;
  private suppressionToken: input_suppression_token | null = null;
  private ephemeralStateResetTimer: ReturnType<typeof setTimeout> | null = null;
  private patchedTerminalFocusHost: HTMLElement | null = null;
  private restoreTerminalFocusHost: (() => void) | null = null;
  private readonly unregisterDocumentShortcutBridge: () => void;

  private readonly keydownListener = (event: KeyboardEvent) => {
    this.handleKeydown(event);
  };

  private readonly beforeInputListener = (event: InputEvent) => {
    this.handleBeforeInput(event);
  };

  private readonly inputListener = () => {
    this.handleInput();
  };

  private readonly compositionStartListener = () => {
    this.handleCompositionStart();
  };

  private readonly compositionEndListener = (event: CompositionEvent) => {
    this.handleCompositionEnd(event);
  };

  private readonly focusListener = () => {
    this.clearInputValue();
  };

  private readonly containerFocusInListener = (event: FocusEvent) => {
    this.handleContainerFocusIn(event);
  };

  private readonly containerPointerDownListener = () => {
    this.scheduleInputFocusClaim();
  };

  private inputFocusClaimTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly input: HTMLTextAreaElement,
    private readonly onData: (data: string) => void,
    private readonly logger: Logger = noopLogger,
    private readonly hasSelection: () => boolean = () => false,
    private readonly copySelection: (
      source: TerminalCopySelectionSource,
      clipboardData?: DataTransfer | null,
    ) => Promise<TerminalCopySelectionResult> | TerminalCopySelectionResult = async (source) => ({
      copied: false,
      reason: 'empty_selection',
      source,
    }),
    private readonly syncInputGeometry: () => void = () => {},
  ) {
    this.input.setAttribute('inputmode', 'text');
    this.input.setAttribute('enterkeyhint', 'enter');
    this.unregisterDocumentShortcutBridge = registerDocumentShortcutBridge(this.container.ownerDocument, this);
    this.attach();
  }

  focus(options?: TerminalFocusOptions): void {
    this.syncInputGeometry();
    focusTerminalElement(this.input, options);
  }

  dispose(): void {
    this.clearEphemeralStateResetTimer();
    this.clearInputFocusClaimTimer();
    this.restoreTerminalFocusHost?.();
    this.restoreTerminalFocusHost = null;
    this.patchedTerminalFocusHost = null;
    this.unregisterDocumentShortcutBridge();
    this.input.removeEventListener('keydown', this.keydownListener);
    this.input.removeEventListener('beforeinput', this.beforeInputListener as EventListener);
    this.input.removeEventListener('input', this.inputListener);
    this.input.removeEventListener('compositionstart', this.compositionStartListener);
    this.input.removeEventListener('compositionend', this.compositionEndListener as EventListener);
    this.input.removeEventListener('focus', this.focusListener);
    this.container.removeEventListener('focusin', this.containerFocusInListener);
    this.container.removeEventListener('pointerdown', this.containerPointerDownListener, true);
  }

  private attach(): void {
    this.patchTerminalFocusHost();
    this.input.addEventListener('keydown', this.keydownListener);
    this.input.addEventListener('beforeinput', this.beforeInputListener as EventListener);
    this.input.addEventListener('input', this.inputListener);
    this.input.addEventListener('compositionstart', this.compositionStartListener);
    this.input.addEventListener('compositionend', this.compositionEndListener as EventListener);
    this.input.addEventListener('focus', this.focusListener);
    this.container.addEventListener('focusin', this.containerFocusInListener);
    this.container.addEventListener('pointerdown', this.containerPointerDownListener, true);
  }

  private handleContainerFocusIn(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target === this.input) {
      return;
    }

    if (!this.isTerminalOwnedEditableTarget(target)) {
      return;
    }

    this.scheduleInputFocusClaim();
  }

  private scheduleInputFocusClaim(): void {
    this.clearInputFocusClaimTimer();
    this.inputFocusClaimTimer = setTimeout(() => {
      this.inputFocusClaimTimer = null;
      const active = this.container.ownerDocument.activeElement;
      if (!(active instanceof HTMLElement) || active === this.input) {
        return;
      }
      if (!this.isTerminalOwnedEditableTarget(active)) {
        return;
      }
      this.focus();
    }, 0);
  }

  private handleKeydown(event: KeyboardEvent): void {
    this.syncInputGeometry();
    if (this.isComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    if (MODIFIER_ONLY_KEYS.has(event.key)) {
      return;
    }

    if (isPlainPrintableKey(event)) {
      return;
    }

    const forwarded = new KeyboardEvent('keydown', cloneKeyboardEventInit(event));
    const notCancelled = this.container.dispatchEvent(forwarded);
    const keydownData = mapKeydownToTerminalData(event);
    this.suppressionToken = createSuppressionTokenFromKeydown(event);
    this.scheduleEphemeralStateReset();

    if (keydownData && notCancelled) {
      this.emitData(keydownData);
    }

    if (!notCancelled || this.suppressionToken) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleBeforeInput(event: InputEvent): void {
    this.syncInputGeometry();
    if (this.isComposing || event.isComposing) {
      return;
    }

    if (this.suppressionToken && matchesBeforeInputSuppression(this.suppressionToken, event)) {
      this.clearEphemeralStateResetTimer();
      this.suppressionToken = null;
      this.ignoreNextInput = true;
      this.scheduleEphemeralStateReset();
      event.preventDefault();
      return;
    }

    const data = mapBeforeInputToTerminalData(event);
    if (!data) {
      return;
    }

    this.ignoreNextInput = true;
    this.scheduleEphemeralStateReset();
    this.emitData(data);
    event.preventDefault();
  }

  private handleInput(): void {
    this.syncInputGeometry();
    if (this.isComposing) {
      return;
    }

    const value = this.input.value;

    if (this.suppressionToken && matchesInputSuppression(this.suppressionToken, value)) {
      this.clearEphemeralStateResetTimer();
      this.suppressionToken = null;
      this.clearInputValue();
      return;
    }

    if (this.ignoreNextInput) {
      this.clearEphemeralStateResetTimer();
      this.ignoreNextInput = false;
      this.clearInputValue();
      return;
    }

    if (value.length > 0) {
      this.emitData(value);
    }

    this.clearInputValue();
  }

  private handleCompositionStart(): void {
    this.syncInputGeometry();
    this.clearEphemeralStateResetTimer();
    this.isComposing = true;
    this.suppressionToken = null;
    this.ignoreNextInput = false;
  }

  private handleCompositionEnd(event: CompositionEvent): void {
    this.syncInputGeometry();
    this.isComposing = false;

    const data = String(event.data ?? this.input.value ?? '');
    if (data.length > 0) {
      this.emitData(data);
    }

    this.ignoreNextInput = true;
    this.scheduleEphemeralStateReset();
    this.clearInputValue();
  }

  containsTarget(target: Node): boolean {
    return target === this.input || this.input.contains(target) || this.container.contains(target);
  }

  tryHandleDocumentCopyShortcut(event: KeyboardEvent): boolean {
    if (this.isComposing || event.isComposing || event.keyCode === 229) {
      return false;
    }

    if (!isPrimaryCopyShortcut(event)) {
      return false;
    }

    if (this.shouldBypassClipboardInterception(event.target)) {
      return false;
    }

    if (!this.hasSelection()) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    this.requestSelectionCopy('shortcut');
    return true;
  }

  tryHandleDocumentCopyEvent(event: ClipboardEvent): boolean {
    if (event.defaultPrevented) {
      return false;
    }

    if (this.shouldBypassClipboardInterception(event.target)) {
      return false;
    }

    if (!this.hasSelection()) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    this.requestSelectionCopy('copy_event', event.clipboardData ?? null);
    return true;
  }

  private shouldBypassClipboardInterception(target: EventTarget | null): boolean {
    if (!isEditableTarget(target)) {
      return false;
    }

    return !this.isTerminalOwnedEditableTarget(target);
  }

  private isTerminalOwnedEditableTarget(target: HTMLElement): boolean {
    if (target === this.input || target === this.container) {
      return true;
    }

    if (!this.container.contains(target)) {
      return false;
    }

    // ghostty-web places the real keyboard focus on an inner contenteditable
    // host. Treat only that terminal-owned host as copy-eligible so embedded
    // user inputs inside overlays still keep their native clipboard behavior.
    return target.matches(TERMINAL_CONTENTEDITABLE_INPUT_SELECTOR);
  }

  private patchTerminalFocusHost(): void {
    const host = this.container.matches(TERMINAL_CONTENTEDITABLE_INPUT_SELECTOR)
      ? this.container
      : this.container.querySelector(TERMINAL_CONTENTEDITABLE_INPUT_SELECTOR);
    if (!(host instanceof HTMLElement) || this.patchedTerminalFocusHost === host) {
      return;
    }

    this.restoreTerminalFocusHost?.();
    this.patchedTerminalFocusHost = host;
    this.restoreTerminalFocusHost = retainTerminalFocusHostPatch(host);
  }

  private requestSelectionCopy(source: TerminalCopySelectionSource, clipboardData: DataTransfer | null = null): void {
    Promise.resolve(this.copySelection(source, clipboardData)).catch(error => {
      this.logger.warn('[TerminalInputBridge] Selection copy failed', { error, source });
    });
  }

  private clearInputValue(): void {
    if (this.input.value.length === 0) {
      return;
    }

    this.input.value = '';
    try {
      this.input.setSelectionRange(0, 0);
    } catch {
      this.logger.debug('[TerminalInputBridge] Failed to reset selection range');
    }
  }

  private emitData(data: string): void {
    if (!data) {
      return;
    }

    this.onData(data);
  }

  private scheduleEphemeralStateReset(): void {
    this.clearEphemeralStateResetTimer();
    this.ephemeralStateResetTimer = setTimeout(() => {
      this.ephemeralStateResetTimer = null;
      this.ignoreNextInput = false;
      this.suppressionToken = null;
    }, 0);
  }

  private clearEphemeralStateResetTimer(): void {
    if (!this.ephemeralStateResetTimer) {
      return;
    }

    clearTimeout(this.ephemeralStateResetTimer);
    this.ephemeralStateResetTimer = null;
  }

  private clearInputFocusClaimTimer(): void {
    if (!this.inputFocusClaimTimer) {
      return;
    }

    clearTimeout(this.inputFocusClaimTimer);
    this.inputFocusClaimTimer = null;
  }
}

const resolveBridgeForTarget = (
  bridges: Set<TerminalInputBridge>,
  target: EventTarget | null,
): TerminalInputBridge | null => {
  if (!(target instanceof Node)) {
    return null;
  }

  for (const bridge of bridges) {
    if (bridge.containsTarget(target)) {
      return bridge;
    }
  }

  return null;
};

const getDocumentShortcutCoordinator = (document: Document): terminal_document_shortcut_coordinator => {
  const existing = documentShortcutCoordinators.get(document);
  if (existing) {
    return existing;
  }

  const coordinator: terminal_document_shortcut_coordinator = {
    activeBridge: null,
    bridges: new Set<TerminalInputBridge>(),
    pointerDownListener: (event) => {
      coordinator.activeBridge = resolveBridgeForTarget(coordinator.bridges, event.target);
    },
    focusInListener: (event) => {
      coordinator.activeBridge = resolveBridgeForTarget(coordinator.bridges, event.target);
    },
    keydownListener: (event) => {
      if (event.defaultPrevented || !isPrimaryCopyShortcut(event)) {
        return;
      }

      const bridge = resolveBridgeForTarget(coordinator.bridges, event.target) ?? coordinator.activeBridge;
      bridge?.tryHandleDocumentCopyShortcut(event);
    },
    copyListener: (event) => {
      if (event.defaultPrevented) {
        return;
      }

      const bridge = resolveBridgeForTarget(coordinator.bridges, event.target) ?? coordinator.activeBridge;
      bridge?.tryHandleDocumentCopyEvent(event);
    },
  };

  document.addEventListener('pointerdown', coordinator.pointerDownListener, true);
  document.addEventListener('focusin', coordinator.focusInListener, true);
  document.addEventListener('keydown', coordinator.keydownListener, true);
  document.addEventListener('copy', coordinator.copyListener, true);

  documentShortcutCoordinators.set(document, coordinator);
  return coordinator;
};

function registerDocumentShortcutBridge(document: Document, bridge: TerminalInputBridge): () => void {
  const coordinator = getDocumentShortcutCoordinator(document);
  coordinator.bridges.add(bridge);

  return () => {
    const current = documentShortcutCoordinators.get(document);
    if (!current) {
      return;
    }

    current.bridges.delete(bridge);
    if (current.activeBridge === bridge) {
      current.activeBridge = null;
    }

    if (current.bridges.size > 0) {
      return;
    }

    document.removeEventListener('pointerdown', current.pointerDownListener, true);
    document.removeEventListener('focusin', current.focusInListener, true);
    document.removeEventListener('keydown', current.keydownListener, true);
    document.removeEventListener('copy', current.copyListener, true);
    documentShortcutCoordinators.delete(document);
  };
}
