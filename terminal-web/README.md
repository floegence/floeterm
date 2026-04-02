# terminal-web

Headless ghostty-web (xterm.js API-compatible) integration with data flow utilities. Provides `TerminalCore` and
`useTerminalInstance` without UI components.

## Install
```bash
npm i @floegence/floeterm-terminal-web
```

## Usage (React)
```tsx
import { useTerminalInstance } from '@floegence/floeterm-terminal-web';

export function TerminalPane() {
  const { containerRef } = useTerminalInstance({
    sessionId: 'session-1',
    isActive: true,
    transport: myTransport,
    eventSource: myEventSource
  });

  return <div ref={containerRef} style={{ height: 400 }} />;
}
```

## Notes
- You must provide a `TerminalTransport` and `TerminalEventSource`.
- `ghostty-web` needs a one-time `init()` (handled internally by `TerminalCore`).
- `TerminalCore` bridges the hidden textarea used by `ghostty-web`, so soft-keyboard and IME input continue to work on touch devices.
- Explicit terminal copy is handled through the standard `copy` command path, so keyboard shortcuts and native app menus can reuse the same selection logic.
- `TerminalCore` now exposes first-class APIs for runtime font updates, shell bell/title events, and custom terminal link providers without reaching into implementation internals.

## Responsive resize (multi-pane / multi-view)
When the same remote terminal session can be displayed in multiple views (e.g. a Deck widget and a dedicated Terminal page),
enable the responsive options so the focused terminal re-syncs cols/rows to the remote PTY:

```ts
import { TerminalCore } from '@floegence/floeterm-terminal-web';

const core = new TerminalCore(container, {
  responsive: {
    fitOnFocus: true,
    emitResizeOnFocus: true,
    notifyResizeOnlyWhenFocused: true,
  },
});
```

## Clipboard behavior
By default, upstream mouse selection keeps the `ghostty-web` behavior and copies immediately on selection.
Consumers that want explicit copy commands only can disable that side effect:

```ts
import { TerminalCore } from '@floegence/floeterm-terminal-web';

const core = new TerminalCore(container, {
  clipboard: {
    copyOnSelect: false,
  },
});
```

## Link providers and shell events
`TerminalCore` forwards shell lifecycle events and lets consumers register custom links over rendered terminal rows:

```ts
import { TerminalCore, type TerminalLinkProvider } from '@floegence/floeterm-terminal-web';

const linkProvider: TerminalLinkProvider = {
  provideLinks(y, callback) {
    void y;
    callback(undefined);
  },
};

const core = new TerminalCore(container, {}, {
  onBell: () => console.log('bell'),
  onTitleChange: (title) => console.log('title', title),
});

await core.initialize();
core.registerLinkProvider(linkProvider);
```

This is the intended extension point for product features such as modifier-click file navigation,
build-log deep links, or shell attention badges driven by bell events.

## Runtime font updates
Consumers that need to react to user preferences can update the font family explicitly:

```ts
core.setFontFamily('"Iosevka Term", monospace');
```
