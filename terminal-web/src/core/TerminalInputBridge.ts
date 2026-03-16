import type { Logger } from '../types';
import { noopLogger } from '../utils/logger';

type input_suppression_token =
  | { kind: 'linebreak' }
  | { kind: 'backspace' };

const TERMINAL_INPUT_SELECTOR = 'textarea[aria-label="Terminal input"]';

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

const createSuppressionTokenFromKeydown = (event: KeyboardEvent): input_suppression_token | null => {
  if (event.key === 'Enter') return { kind: 'linebreak' };
  if (event.key === 'Backspace') return { kind: 'backspace' };
  return null;
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

  constructor(
    private readonly container: HTMLElement,
    private readonly input: HTMLTextAreaElement,
    private readonly onData: (data: string) => void,
    private readonly logger: Logger = noopLogger,
  ) {
    this.input.setAttribute('inputmode', 'text');
    this.input.setAttribute('enterkeyhint', 'enter');
    this.attach();
  }

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.clearEphemeralStateResetTimer();
    this.input.removeEventListener('keydown', this.keydownListener);
    this.input.removeEventListener('beforeinput', this.beforeInputListener as EventListener);
    this.input.removeEventListener('input', this.inputListener);
    this.input.removeEventListener('compositionstart', this.compositionStartListener);
    this.input.removeEventListener('compositionend', this.compositionEndListener as EventListener);
    this.input.removeEventListener('focus', this.focusListener);
  }

  private attach(): void {
    this.input.addEventListener('keydown', this.keydownListener);
    this.input.addEventListener('beforeinput', this.beforeInputListener as EventListener);
    this.input.addEventListener('input', this.inputListener);
    this.input.addEventListener('compositionstart', this.compositionStartListener);
    this.input.addEventListener('compositionend', this.compositionEndListener as EventListener);
    this.input.addEventListener('focus', this.focusListener);
  }

  private handleKeydown(event: KeyboardEvent): void {
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
    this.suppressionToken = createSuppressionTokenFromKeydown(event);
    this.scheduleEphemeralStateReset();

    if (!notCancelled || this.suppressionToken) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleBeforeInput(event: InputEvent): void {
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
    this.clearEphemeralStateResetTimer();
    this.isComposing = true;
    this.suppressionToken = null;
    this.ignoreNextInput = false;
  }

  private handleCompositionEnd(event: CompositionEvent): void {
    this.isComposing = false;

    const data = String(event.data ?? this.input.value ?? '');
    if (data.length > 0) {
      this.emitData(data);
    }

    this.ignoreNextInput = true;
    this.scheduleEphemeralStateReset();
    this.clearInputValue();
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
}
