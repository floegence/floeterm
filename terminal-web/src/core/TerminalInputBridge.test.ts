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

  const setup = (selectionText = '') => {
    const container = document.createElement('div');
    const textarea = document.createElement('textarea');
    container.appendChild(textarea);
    document.body.appendChild(container);
    const onData = vi.fn();
    const copySelection = vi.fn().mockResolvedValue({
      copied: selectionText.length > 0,
      textLength: selectionText.length,
      source: 'command',
    });
    const bridge = new TerminalInputBridge(
      container,
      textarea,
      onData,
      undefined,
      () => selectionText.length > 0,
      copySelection,
    );
    return { bridge, container, textarea, onData, copySelection };
  };

  it('sends plain text from beforeinput without waiting for keydown', () => {
    const { textarea, onData } = setup();

    textarea.dispatchEvent(createInputEvent('beforeinput', {
      data: 'a',
      inputType: 'insertText',
    }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('a');
  });

  it('falls back to input value when beforeinput is unavailable', () => {
    const { textarea, onData } = setup();

    textarea.value = 'hello';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith('hello');
    expect(textarea.value).toBe('');
  });

  it('forwards special keys to the terminal container and suppresses duplicated beforeinput', () => {
    const { container, textarea, onData } = setup();

    container.addEventListener('keydown', (event) => {
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

    bridge.focus();

    expect(document.activeElement).toBe(textarea);
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

  it('does not hijack Cmd/Ctrl+C when the terminal has no selection', async () => {
    const { container, textarea, copySelection } = setup('');
    const forwarded = vi.fn((event: KeyboardEvent) => event.target === container);
    container.addEventListener('keydown', forwarded);

    activateTerminal(container);
    const event = new KeyboardEvent('keydown', {
      key: 'c',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    textarea.dispatchEvent(event);
    await Promise.resolve();

    expect(copySelection).not.toHaveBeenCalled();
    expect(forwarded.mock.calls.filter(([forwardedEvent]) => forwardedEvent.target === container)).toHaveLength(1);
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
