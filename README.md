# FloeTerm

FloeTerm is semantic terminal infrastructure for product teams. A Go `SessionActor`
owns the PTY and one native Ghostty VT instance. Browsers receive immutable semantic
presentations and provide view-local rendering, palette, selection, and input.

[![CI](https://img.shields.io/github/actions/workflow/status/floegence/floeterm/ci.yml?branch=main&label=CI)](https://github.com/floegence/floeterm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40floegence%2Ffloeterm-terminal-web?label=npm)](https://www.npmjs.com/package/@floegence/floeterm-terminal-web)
[![Go Reference](https://pkg.go.dev/badge/github.com/floegence/floeterm/terminal-go.svg)](https://pkg.go.dev/github.com/floegence/floeterm/terminal-go)
[![License](https://img.shields.io/github/license/floegence/floeterm)](./LICENSE)

## Architecture

FloeTerm has one terminal state owner:

```text
PTY bytes/input/resize/history
             |
             v
terminal-go SessionActor + native Ghostty VT
             |
             v
immutable SemanticPresentation
             |
             v
terminal-web RendererSurface + TerminalInputBridge
```

The browser does not run a second VT parser, restore raw checkpoints, replay a raw
journal, or own PTY geometry. Every view renders the same authoritative frame while
keeping its palette, canvas backing store, selection, crop/pad, and IME anchor local.

Key contracts:

- PTY output, structured input, resize, semantic clear, and semantic history are serialized by the
  session actor.
- User-visible clear is a generation-bound `Session.ClearSemanticScreen` operation:
  the native VT owner resets screen, bounded semantic history, graphics, and view
  projections, then publishes one new `contentEpoch` to every attached view. It never
  sends Ctrl-L or clears only a browser canvas.
- A Presentation contains matching state, geometry, frame, cursor, and graphics.
- Live transport uses a bounded reliable FIFO plus one latest-Presentation slot.
- Only the current controller changes PTY geometry or sends input; observers remain
  render-only.
- Resize acknowledgements mean canonical geometry was actually applied.
- IME composition commits Unicode input exactly once and anchors to the semantic
  cursor without applying device-pixel ratio twice.

## Packages

| Package | Contract |
| --- | --- |
| [`terminal-go`](./terminal-go) | PTY lifecycle, native Ghostty SessionActor, canonical geometry, controller ownership, semantic presentations, bounded semantic history, and live protocol backend |
| [`terminal-web`](./terminal-web) | Presentation validator, canvas `RendererSurface`, `TerminalInputBridge`, semantic live transport, themes, and session metadata utilities |
| [`app/`](./app) | Reference HTTP/WebSocket backend and Solid.js UI for single, mirror, and grid views |

Install the released packages:

```bash
go get github.com/floegence/floeterm/terminal-go@v0.10.1
npm install @floegence/floeterm-terminal-web@0.15.1
```

## Browser Integration

Use explicit semantic subpaths so product adapters depend only on the capability they
need:

```ts
import {
  RendererSurface,
  TerminalInputBridge,
  getThemeColors,
  validatePresentation,
} from '@floegence/floeterm-terminal-web/semantic';
import {
  createSemanticTerminalLiveTransport,
} from '@floegence/floeterm-terminal-web/live';

const canvas = document.querySelector('canvas')!;
const renderer = new RendererSurface(canvas, console.error);
renderer.setPalette(getThemeColors('tokyoNight'));

const bundle = createSemanticTerminalLiveTransport({
  connectionId: crypto.randomUUID(),
  openStream,
  control,
});

const unsubscribe = bundle.eventSource.onTerminalPresentation(sessionId, value => {
  renderer.apply(validatePresentation(value));
});

const input = new TerminalInputBridge({
  inputHost,
  inputElement,
  onData: data => void bundle.transport.sendInput(sessionId, data),
  syncInputGeometry: () => positionInputAt(renderer.getCursorClientRect()),
});
```

`RendererSurface` is the only canvas writer. Host bounds determine CSS size; the
renderer updates DPR backing, fills the full background, and paints the latest
Presentation in one scheduled draw. Theme changes repaint the same Presentation and
never mutate the PTY or transport sequence.

## Go Integration

```go
manager := terminal.NewManager(terminal.ManagerConfig{})
session, err := manager.CreateSession("shell", "")
if err != nil {
    return err
}
if err := manager.ActivateSession(session.ID, 120, 40); err != nil {
    return err
}
```

Use `livev1.NewService` with the manager backend for the bidirectional semantic live
stream. The reference server in [`app/backend`](./app/backend) shows attach, input,
resize, generation-bound semantic clear, presentation, lifecycle, and
semantic-history endpoints.

## Reference App

Build and run on loopback:

```bash
make run
```

Then open `http://127.0.0.1:8280`. The app supports single, mirrored, and grid views
of one session, view-local themes, cursor shapes and visibility, IME, CJK/emoji,
Kitty graphics, reconnect, and continuous resize.

## Development

```bash
make check
```

The final gate runs Go race tests and vulnerability checks, terminal-web unit/browser
and package-artifact checks, app tests, real-process Playwright E2E, and npm audits.
Native focused checks are available with `make native-check`.

The `terminal-go/internal/nativevt/generated` directory contains reproducible static
archives for Darwin/Linux on amd64/arm64, the thin public-API adapter, Ghostty license,
and exact source/artifact hashes. Regenerate them with `scripts/build_native_vt.sh`
from the pinned Ghostty source and toolchain recorded by that script.

## Repository Layout

| Path | Purpose |
| --- | --- |
| [`terminal-go/`](./terminal-go) | Go PTY/session actor and native semantic engine |
| [`terminal-web/`](./terminal-web) | Framework-neutral semantic browser package |
| [`app/backend/`](./app/backend) | Reference control plane and WebSocket service |
| [`app/web/`](./app/web) | Reference semantic terminal UI |
| [`e2e/`](./e2e) | Real-process functional and diagnostic performance tests |

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for third-party licensing.
