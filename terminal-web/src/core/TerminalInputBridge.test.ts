// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { TerminalInputBridge } from './TerminalInputBridge';

const createInputEvent = (
  type: string,
  init: { data?: string | null; inputType?: string; isComposing?: boolean } = {},
): InputEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as InputEvent;
  Object.defineProperty(event, 'data', { value: init.data ?? null });
  Object.defineProperty(event, 'inputType', { value: init.inputType ?? '' });
  Object.defineProperty(event, 'isComposing', { value: Boolean(init.isComposing) });
  return event;
};

describe('TerminalInputBridge', () => {
  const activateTerminal = (target: HTMLElement) => {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
  };

  const setup = (selectionText = '', options: { terminalInputHost?: boolean } = {}) => {
    const container = document.createElement('div');
    const textarea = document.createElement('textarea');
    let terminalInputHost: HTMLDivElement | null = null;
    if (options.terminalInputHost) {
      terminalInputHost = document.createElement('div');
      terminalInputHost.setAttribute('contenteditable', 'true');
      terminalInputHost.setAttribute('aria-label', 'Terminal input');
      terminalInputHost.appendChild(textarea);
      container.appendChild(terminalInputHost);
    } else {
      container.appendChild(textarea);
    }
    document.body.appendChild(container);
    const onData = vi.fn();
    const copySelection = vi.fn().mockResolvedValue({
      copied: selectionText.length > 0,
      textLength: selectionText.length,
      source: 'command',
    });
    const inputHost = terminalInputHost ?? container;
    const bridge = new TerminalInputBridge({
      inputHost,
      inputElement: textarea,
      onData,
      hasSelection: () => selectionText.length > 0,
      copySelection,
    });
    return { bridge, container, inputHost, textarea, terminalInputHost, onData, copySelection };
  };

  it('sends plain text from beforeinput without waiting for keydown', () => {
    const { textarea, onData } = setup();
    const targetListener = vi.fn();
    textarea.addEventListener('beforeinput', targetListener);

    textarea.dispatchEvent(createInputEvent('beforeinput', {
      data: 'a',
      inputType: 'insertText',
    }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('a');
    expect(targetListener).not.toHaveBeenCalled();
  });

  it('falls back to input value when beforeinput is unavailable', () => {
    const { textarea, onData } = setup();

    textarea.value = 'hello';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('hello');
    expect(textarea.value).toBe('');
  });

  it('forwards special keys to the terminal input host and suppresses duplicated beforeinput', () => {
    const { inputHost, textarea, onData } = setup();

    inputHost.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        onData('\r');
        event.preventDefault();
      }
    });

    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    textarea.dispatchEvent(createInputEvent('beforeinput', {
      data: null,
      inputType: 'insertLineBreak',
    }));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('\r');
  });

  it('emits plain text once when keydown is followed by beforeinput and input', () => {
    const { textarea, onData } = setup();

    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'A',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    textarea.dispatchEvent(createInputEvent('beforeinput', {
      data: 'A',
      inputType: 'insertText',
    }));
    textarea.value = 'A';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('A');
    expect(textarea.value).toBe('');
  });

  it('emits IME text once on compositionend', () => {
    const { textarea, onData } = setup();

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.value = '你';
    textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '你',
    }));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('你');
    expect(textarea.value).toBe('');
  });

  it('focuses the hidden textarea when requested', () => {
    const { bridge, textarea } = setup();
    const focusCalls: Array<FocusOptions | undefined> = [];
    const originalFocus = HTMLTextAreaElement.prototype.focus;
    const focusSpy = vi
      .spyOn(HTMLTextAreaElement.prototype, 'focus')
      .mockImplementation(function focus(this: HTMLTextAreaElement, options?: FocusOptions) {
        focusCalls.push(options);
        originalFocus.call(this);
      });

    bridge.focus();

    expect(document.activeElement).toBe(textarea);
    expect(focusCalls).toEqual([{ preventScroll: true }]);
    focusSpy.mockRestore();
  });

  it('keeps a portaled terminal input inside the bridge ownership boundary', () => {
    const { bridge, container, textarea } = setup();
    document.body.appendChild(textarea);

    expect(container.contains(textarea)).toBe(false);
    expect(bridge.containsTarget(textarea)).toBe(true);

    bridge.dispose();
  });

  it('lets callers opt into native focus scrolling', () => {
    const { bridge } = setup();
    const focusCalls: Array<FocusOptions | undefined> = [];
    const focusSpy = vi
      .spyOn(HTMLTextAreaElement.prototype, 'focus')
      .mockImplementation(function focus(_options?: FocusOptions) {
        focusCalls.push(_options);
      });

    bridge.focus({ preventScroll: false });

    expect(focusCalls).toEqual([{ preventScroll: false }]);
    focusSpy.mockRestore();
  });

  it('patches native terminal host focus to avoid browser scroll alignment', () => {
    const focusCalls: Array<FocusOptions | undefined> = [];
    const originalFocus = HTMLElement.prototype.focus;
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function focus(this: HTMLElement, options?: FocusOptions) {
        focusCalls.push(options);
        originalFocus.call(this);
      });
    const { bridge, terminalInputHost } = setup('', { terminalInputHost: true });
    expect(terminalInputHost).toBeTruthy();

    terminalInputHost!.focus();
    terminalInputHost!.focus({ preventScroll: false });
    bridge.dispose();
    terminalInputHost!.focus({ preventScroll: false });

    expect(focusCalls).toEqual([
      { preventScroll: true },
      { preventScroll: false },
      { preventScroll: false },
    ]);
    focusSpy.mockRestore();
  });

  it('restores shared terminal host focus after out-of-order bridge disposal', () => {
    const focusCalls: Array<FocusOptions | undefined> = [];
    const originalFocus = HTMLElement.prototype.focus;
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function focus(this: HTMLElement, options?: FocusOptions) {
        focusCalls.push(options);
        originalFocus.call(this);
      });
    const { bridge: firstBridge, inputHost, textarea, terminalInputHost } = setup('', { terminalInputHost: true });
    expect(terminalInputHost).toBeTruthy();
    const secondBridge = new TerminalInputBridge({
      inputHost,
      inputElement: textarea,
      onData: vi.fn(),
    });

    terminalInputHost!.focus();
    firstBridge.dispose();
    terminalInputHost!.focus();
    secondBridge.dispose();
    terminalInputHost!.focus();

    expect(focusCalls).toEqual([
      { preventScroll: true },
      { preventScroll: true },
      undefined,
    ]);
    expect(Object.prototype.hasOwnProperty.call(terminalInputHost, 'focus')).toBe(false);
    focusSpy.mockRestore();
  });

  it('keeps terminal pointer events available for native mouse handling', () => {
    const { terminalInputHost } = setup('', { terminalInputHost: true });
    expect(terminalInputHost).toBeTruthy();
    const canvas = document.createElement('canvas');
    terminalInputHost!.appendChild(canvas);
    const bubbled = vi.fn();
    terminalInputHost!.addEventListener('pointerdown', bubbled);

    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'button', { value: 0 });
    canvas.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it('does not prevent pointer focus for non-terminal editables inside the container', () => {
    const { container } = setup();
    const input = document.createElement('input');
    container.appendChild(input);

    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'button', { value: 0 });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('routes Cmd/Ctrl+C through the shared copy path when the terminal has a selection', async () => {
    const { container, copySelection } = setup('echo hi');
    activateTerminal(container);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(copySelection).toHaveBeenCalledWith('shortcut', null);
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes Ctrl+C to the terminal input host when the terminal has no selection', async () => {
    const { inputHost, textarea, onData, copySelection } = setup('');
    inputHost.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.code === 'KeyC') {
        onData('\x03');
        event.preventDefault();
        event.stopPropagation();
      }
    });

    activateTerminal(inputHost);
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('\x03');
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not convert Cmd+C into terminal input when the terminal has no selection', async () => {
    const { inputHost, textarea, onData, copySelection } = setup('');
    const forwarded = vi.fn((event: KeyboardEvent) => event.target === inputHost);
    inputHost.addEventListener('keydown', forwarded);

    activateTerminal(inputHost);
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
    expect(forwarded.mock.calls.filter(([forwardedEvent]) => forwardedEvent.target === inputHost)).toHaveLength(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('clears the active terminal copy scope after interacting outside the container', async () => {
    const { container, copySelection } = setup('echo hi');
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    activateTerminal(container);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not hijack Cmd/Ctrl+C from non-terminal editable targets inside the container', async () => {
    const { container, copySelection } = setup('terminal selection');
    const extraInput = document.createElement('input');
    container.appendChild(extraInput);
    activateTerminal(extraInput);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    extraInput.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('treats a contenteditable terminal host as terminal-owned for Cmd/Ctrl+C copy', async () => {
    const { container, copySelection } = setup('terminal selection');
    container.setAttribute('contenteditable', 'true');
    activateTerminal(container);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    container.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(copySelection).toHaveBeenCalledWith('shortcut', null);
    expect(event.defaultPrevented).toBe(true);
  });

  it('treats the inner ghostty contenteditable input host as terminal-owned for Cmd/Ctrl+C copy', async () => {
    const { container, copySelection } = setup('terminal selection');
    const terminalInputHost = document.createElement('div');
    terminalInputHost.setAttribute('contenteditable', 'true');
    terminalInputHost.setAttribute('aria-label', 'Terminal input');
    container.appendChild(terminalInputHost);
    activateTerminal(terminalInputHost);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    terminalInputHost.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(copySelection).toHaveBeenCalledWith('shortcut', null);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not hijack Cmd/Ctrl+C from non-terminal contenteditable targets inside the container', async () => {
    const { container, copySelection } = setup('terminal selection');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    container.appendChild(editor);
    activateTerminal(editor);

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    editor.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('routes the standard copy event through the shared copy path', async () => {
    const selection = '  echo hi\n';
    const { container, copySelection } = setup(selection);
    activateTerminal(container);
    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    document.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(copySelection).toHaveBeenCalledWith('copy_event', expect.objectContaining({ setData }));
    expect(event.defaultPrevented).toBe(true);
  });

  it('routes copy events from the inner ghostty contenteditable input host through the shared copy path', async () => {
    const selection = 'terminal selection';
    const { container, copySelection } = setup(selection);
    const terminalInputHost = document.createElement('div');
    terminalInputHost.setAttribute('contenteditable', 'true');
    terminalInputHost.setAttribute('aria-label', 'Terminal input');
    container.appendChild(terminalInputHost);
    activateTerminal(terminalInputHost);
    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    terminalInputHost.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(copySelection).toHaveBeenCalledWith('copy_event', expect.objectContaining({ setData }));
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not hijack copy events from non-terminal editable targets inside the container', () => {
    const { container } = setup('terminal selection');
    const extraInput = document.createElement('input');
    container.appendChild(extraInput);

    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    extraInput.dispatchEvent(event);

    expect(setData).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
