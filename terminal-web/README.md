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
- Explicit terminal copy is handled through shared selection-copy APIs, so keyboard shortcuts, native app menus, and product context menus can reuse the same selection logic.
- `TerminalCore` now exposes first-class APIs for runtime appearance updates, shell bell/title events, and custom terminal link providers without reaching into implementation internals.

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

Passive mirrors of a remote PTY can render with the session owner's current dimensions instead of fitting their own
container:

```ts
const core = new TerminalCore(container, {
  fixedDimensions: { cols: 100, rows: 30 },
});

// Later, when this surface becomes the active geometry owner:
core.setFixedDimensions(null);
core.forceResize();
```

Hosts with overlay scrollbars can remove the default ghostty-web scrollbar reserve so the computed grid fills the
terminal surface:

```ts
const core = new TerminalCore(container, {
  fit: {
    scrollbarReservePx: 0,
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

With `copyOnSelect: false`, `TerminalCore` keeps selection explicit:

- `core.hasSelection()` reports whether the terminal currently owns a copyable selection.
- `core.copySelection()` writes the current terminal selection to the clipboard.
- `Cmd+C` / `Ctrl+C` only claims the shortcut when the terminal currently has a selection. Otherwise the shortcut falls through unchanged.

If you use the React hook, the same helpers are available on `actions.hasSelection()` and `actions.copySelection()`.

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

## Visual work suspension
Hosts that animate a surrounding workbench can temporarily suspend expensive terminal visual work while keeping PTY output
and the terminal buffer live:

```ts
const suspend = core.beginVisualSuspend({ reason: 'workbench_widget_drag' });

try {
  // Move, zoom, or resize the host surface.
} finally {
  suspend.dispose();
}
```

While suspended, `write()` continues to update terminal state. Rendering, fit, full repaint, and overlay refresh requests
are coalesced and reconciled when the final nested suspend handle is disposed.

## Runtime appearance updates
Consumers that need to react to user preferences can update appearance without rebuilding the
terminal session:

```ts
import { getThemeColors } from '@floegence/floeterm-terminal-web';

core.setAppearance({
  theme: getThemeColors('light'),
  fontSize: 14,
  fontFamily: '"Iosevka Term", monospace',
  presentationScale: 1,
});

core.setFontFamily('"Iosevka Term", monospace');
```
