# floeterm

<p align="center">
  <strong>Open-source terminal infrastructure for product teams.</strong><br />
  <sub>Embed a real terminal into your product with a PTY-backed Go backend, a headless web terminal wrapper, and a runnable reference app.</sub>
</p>

<p align="center">
  <a href="https://github.com/floegence/floeterm/actions/workflows/ci.yml">
    <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/floegence/floeterm/ci.yml?branch=main&label=CI" />
  </a>
  <a href="https://github.com/floegence/floeterm/releases">
    <img alt="Release" src="https://img.shields.io/github/v/tag/floegence/floeterm?label=release" />
  </a>
  <a href="https://www.npmjs.com/package/@floegence/floeterm-terminal-web">
    <img alt="npm" src="https://img.shields.io/npm/v/%40floegence%2Ffloeterm-terminal-web?label=npm" />
  </a>
  <a href="https://pkg.go.dev/github.com/floegence/floeterm/terminal-go">
    <img alt="Go Reference" src="https://pkg.go.dev/badge/github.com/floegence/floeterm/terminal-go.svg" />
  </a>
  <a href="./LICENSE">
    <img alt="License" src="https://img.shields.io/github/license/floegence/floeterm" />
  </a>
</p>

<p align="center">
  <img alt="Headless UI" src="https://img.shields.io/badge/Headless-UI%20agnostic-0f766e?style=for-the-badge" />
  <img alt="PTY-backed" src="https://img.shields.io/badge/PTY-backed%20sessions-164e63?style=for-the-badge" />
  <img alt="History Replay" src="https://img.shields.io/badge/History-Replay%20ready-7c2d12?style=for-the-badge" />
  <img alt="IME Ready" src="https://img.shields.io/badge/IME%20%2B%20Touch-Input%20bridge-1d4ed8?style=for-the-badge" />
  <img alt="Multi-view resize" src="https://img.shields.io/badge/Multi--view-Resize%20coordination-6d28d9?style=for-the-badge" />
  <img alt="Reference App" src="https://img.shields.io/badge/Reference-App%20included-c2410c?style=for-the-badge" />
</p>

<p align="center">
  <a href="#-why-floeterm">Why floeterm</a> ·
  <a href="#-packages">Packages</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-development">Development</a>
</p>

## 🎯 Why floeterm

`floeterm` is built for teams that want terminal workflows inside their own product, not inside someone else's UI shell.

- `Product-first`: ship your own terminal experience while floeterm handles PTY lifecycle, history replay, resize coordination, and browser-facing terminal plumbing.
- `Composable`: use [`terminal-go`](./terminal-go) as the backend engine, [`terminal-web`](./terminal-web) as the headless browser layer, or start from the end-to-end reference app in [`app/`](./app).
- `User-ready`: mobile-friendly input bridging, IME support, reconnect-friendly history replay, configurable clipboard behavior, and first-class shell bell/title plus link-provider hooks are already in the stack.
- `Operationally sane`: one `make check` path matches CI for Go race tests, `govulncheck`, web lint/test/build, and `npm audit`.

Typical use cases:

- AI coding workspaces and browser IDEs
- Cloud admin consoles and internal ops tools
- Remote development environments
- Embedded terminals inside dashboards, drawers, tabs, or dedicated terminal pages

## ✨ Feature Tags

| Tag | What it means in practice |
| --- | --- |
| `🧩 HEADLESS UI` | `terminal-web` exposes `TerminalCore`, `useTerminalInstance`, and `TerminalSessionsCoordinator` without forcing a component library or design system. |
| `🌱 DORMANT-FIRST` | Sessions can be created before the PTY starts, then activated with the real viewport size on first attach. |
| `📚 HISTORY REPLAY` | Scrollback is buffered, filtered, and replayed safely after reconnects or remounts. |
| `⌨️ IME READY` | The web layer bridges the hidden textarea used by `ghostty-web`, keeping soft keyboard and composition input usable on touch devices. |
| `📐 MULTI-VIEW` | Responsive resize controls help keep one remote session usable across panes, tabs, and focused terminal views. |
| `🔗 ACTIONABLE OUTPUT` | Custom link providers and bell/title forwarding let products turn terminal output into file navigation, alerts, and richer UX without patching internals. |
| `🧪 REFERENCE APP` | A runnable HTTP + WebSocket app shows the full integration path end to end. |

## 📦 Packages

| Package | Best for | What you get |
| --- | --- | --- |
| [`terminal-go`](./terminal-go) | Go backends that need PTY sessions | Session lifecycle, history buffering/filtering, explicit workdir signal parsing, resize coordination, and event hooks |
| [`terminal-web`](./terminal-web) | React and web clients that want terminal plumbing without UI lock-in | `TerminalCore`, `useTerminalInstance`, `TerminalSessionsCoordinator`, config helpers, and a headless `ghostty-web` wrapper |
| [`app/`](./app) | Teams that want a working reference before integrating | HTTP APIs, WebSocket streaming, and a React demo UI that wires the stack together |

Install the building blocks you need:

```bash
go get github.com/floegence/floeterm/terminal-go
npm i @floegence/floeterm-terminal-web
```

## 👀 What Problems It Solves

| You need to... | floeterm gives you... |
| --- | --- |
| Start a session before layout is stable | Dormant-first session creation via `CreateSession`, then PTY activation with real `cols/rows` via `ActivateSession` or first attach |
| Restore terminal output after reconnect or remount | History chunks, replay windows, and filtering that removes problematic terminal auto-responses |
| Support touch devices and IME input | A browser input bridge that keeps composition and soft keyboard flows working with `ghostty-web` |
| Reuse one session across multiple surfaces | Per-connection sizing on the backend plus focus-aware responsive resize options in the web layer |
| Turn terminal output into product interactions | Custom link providers, bell events, and title updates surfaced through `TerminalCore` |
| Evaluate quickly before integrating | A reference app you can run locally in minutes |

## 🚀 Quick Start

### 1. Run the reference app

```bash
make run
```

Then open `http://localhost:8280`.

- `make run` serves the bundled app and is also reachable from other devices on your LAN via `http://<your-ip>:8280`.
- `make dev` starts the Go backend on `0.0.0.0:8080` and the Vite dev server on `0.0.0.0:5173` for HMR and cross-device debugging.

### 2. Start a PTY-backed session in Go

```go
package main

import (
	"log"

	terminal "github.com/floegence/floeterm/terminal-go"
)

func main() {
	manager := terminal.NewManager(terminal.ManagerConfig{})

	session, err := manager.CreateSession("", "")
	if err != nil {
		log.Fatal(err)
	}

	if err := manager.ActivateSession(session.ID, 120, 40); err != nil {
		log.Fatal(err)
	}

	if err := session.WriteDataWithSource([]byte("ls\n"), ""); err != nil {
		log.Fatal(err)
	}
}
```

### 3. Mount the terminal in React

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

## 🧭 Integration Notes

| Topic | Notes |
| --- | --- |
| Platform | `terminal-go` relies on a POSIX PTY and is tested on macOS/Linux. |
| Lifecycle | `CreateSession` creates a dormant logical session. The first attach or an explicit `ActivateSession` should provide the real terminal viewport size. |
| Working directory tracking | `terminal-go` follows explicit cwd OSC markers (`633;P;Cwd`, `1337;CurrentDir`, `OSC 7`) and buffers incomplete frames across PTY reads instead of guessing from generic terminal title changes. |
| UI ownership | `terminal-web` is intentionally headless. You own the surrounding layout, session list, controls, and product experience. |
| Input model | `TerminalCore` handles one-time `ghostty-web` initialization internally and supports explicit-copy-only clipboard behavior when you disable copy-on-select. |
| Extension hooks | `TerminalCore` exposes link providers, shell bell/title callbacks, and explicit runtime font updates so downstream apps do not need `any`-based terminal mutations. |
| Reference transport | The sample app uses HTTP APIs for control operations and WebSocket streaming for terminal output. |

## 🛠 Development

| Command | What it does |
| --- | --- |
| `make check` | Runs the same hard gates as CI: Go race tests, `govulncheck`, web lint/test/build, and `npm audit` |
| `make run` | Builds and serves the reference app from the Go backend |
| `make dev` | Runs backend + Vite dev server separately for local iteration |
| `make app-web-build` | Builds the reference web app only |

## 🗂 Repository Layout

| Path | Purpose |
| --- | --- |
| [`terminal-go/`](./terminal-go) | Go PTY session manager |
| [`terminal-web/`](./terminal-web) | Headless web terminal package for React/web apps |
| [`app/backend/`](./app/backend) | HTTP + WebSocket backend reference implementation |
| [`app/web/`](./app/web) | React reference UI |

## 📄 Notices

- Third-party notices: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
- License: [MIT](./LICENSE)
