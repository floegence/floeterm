# @floegence/floeterm-terminal-web

Framework-neutral browser components for FloeTerm's semantic terminal protocol.

The package does not contain a VT parser, Ghostty WASM, a raw replay/checkpoint
pipeline, or a WebGL terminal renderer. `terminal-go` owns terminal state and emits
complete immutable Presentations. The browser owns only view-local rendering and
interaction.

## Install

```bash
npm install @floegence/floeterm-terminal-web@0.15.7
```

## Exports

| Subpath | API |
| --- | --- |
| `./semantic` | `RendererSurface`, `TerminalInputBridge`, validators, semantic types, themes |
| `./live` | semantic WebSocket codec, client, transport, lifecycle and geometry events |
| `./sessions` | session coordinator and display-only metadata normalization |
| `.` | semantic aggregation plus shell-integration parsing utilities |

## Render a Presentation

```ts
import {
  RendererSurface,
  getThemeColors,
  validatePresentation,
} from '@floegence/floeterm-terminal-web/semantic';

const renderer = new RendererSurface(canvas, error => showInlineError(error));
renderer.setPalette(getThemeColors('tokyoNight'));
const metrics = renderer.setTypography({
  fontSizeCssPx: 14,
  fontFamily: '"JetBrains Mono", monospace',
});
renderer.apply(validatePresentation(payload));
```

`RendererSurface` owns one 2D canvas. It keeps the latest immutable Presentation,
rejects sequence or geometry regressions, follows host CSS bounds, tracks DPR changes,
fills every backing pixel before painting cells/graphics/cursor, and never stretches
the authoritative cell grid to an observer viewport.

Typography is view-local. `setTypography()` returns the exact CSS cell metrics used
for glyphs, graphics, selection hit-testing, cursor painting, and IME anchoring.
Use the same metrics to calculate desired columns and rows before sending a canonical
resize request. Font changes repaint the latest Presentation without replacing the
canvas or creating terminal state in the browser.

For keep-mounted panes, call `renderer.setVisible(false)` before hiding the host.
After the active host has its real content-box bounds, call `renderer.setVisible(true)`.
The visible call synchronously commits the current DPR backing, full background, and
latest Presentation before exposing the same canvas, so an old bitmap is never
stretched by CSS during a tab or Workbench switch.

Themes are view-local. Changing the palette repaints the latest Presentation without
requesting output, resizing the PTY, or affecting another view. Explicit ANSI/RGB
colors stay semantic; only default foreground/background/cursor fallbacks change.

## Input and IME

```ts
import { TerminalInputBridge } from '@floegence/floeterm-terminal-web/semantic';

const bridge = new TerminalInputBridge({
  inputHost,
  inputElement: textarea,
  onData: data => transport.sendInput(sessionId, data),
  onInputIntent: intent => transport.sendInputIntent(sessionId, intent),
  syncInputGeometry: () => positionTextarea(renderer.getCursorLayoutRect()),
});
```

The textarea must remain editable and positioned in the visible terminal viewport.
Composition preedit is never sent to the PTY. The final Unicode composition commit is
sent exactly once across Chrome/Safari event orderings. Non-text keys are emitted as
structured W3C key intents so the actor-owned native Ghostty encoder, not the browser,
resolves cursor modes, modifiers, and terminal escape sequences. Paste, dead-key/emoji
input, copy shortcuts, focus, and controller ownership remain separate from composition
state.

Both cursor rectangle APIs use CSS pixels; canvas backing DPR is never multiplied
into the IME anchor. Use `getCursorLayoutRect()` when the editable element is
absolutely positioned in the canvas containing block. Use `getCursorClientRect()`
only for a fixed or portal element positioned in viewport coordinates.

## Semantic Live Transport

```ts
import {
  createSemanticTerminalLiveTransport,
} from '@floegence/floeterm-terminal-web/live';

const { transport, eventSource } = createSemanticTerminalLiveTransport({
  connectionId,
  openStream,
  control,
  onError: reportError,
});

await transport.attach(sessionId, cols, rows);
const stop = eventSource.onTerminalPresentation(sessionId, value => {
  renderer.apply(validatePresentation(value));
});

// Only a real user activation may transfer controller ownership and PTY size.
await transport.activate(sessionId, desiredCols, desiredRows);
```

The transport carries attach, structured input, canonical resize settlement,
explicit same-principal view activation, controller ownership events, generation-bound
semantic clear settlement, Presentation, geometry, and lifecycle frames. Observer
resize reports its local viewport but cannot change canonical PTY geometry. A real
activation validates attachment, principal, transport generation, and controller epoch,
then transfers ownership, applies geometry, and captures the matching Presentation in
one actor ordering window. A racing stale epoch has zero effect and is resettled a
bounded number of times without detaching or reconnecting the stream.

The transport does not carry raw PTY output. `clearSemanticContent(sessionId)` invokes
the native SessionActor clear control through the current transport generation and
rejects a settlement if that generation was superseded.
Unknown input is not replayed after a disconnect. A new transport generation does not
write through an old connection.

## Session Metadata

The `./sessions` entry is independent of rendering. It normalizes session list,
foreground command, output activity, execution context, and semantic work metadata.
These values are display-only and must not be used for authorization.

## Lifecycle

Dispose each view's subscriptions, input bridge, renderer, and live transport. Disposal
cancels RAF/blink/DPR/font listeners and releases graphics bitmaps without detaching or
resizing another view.

## Development

```bash
npm ci
npm run lint
npm test
npm run test:browser
npm run build
npm run check:package-artifact
```

The package-artifact check installs the packed tarball into a fresh consumer and
rejects removed parser, checkpoint, renderer, and WASM contracts.
