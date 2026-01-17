# floeterm

`floeterm` is a small monorepo that provides:
- a Go PTY-backed terminal session manager (`terminal-go`), and
- a headless xterm.js wrapper + React hook for web clients (`terminal-web`),
plus a runnable reference app (`app/`) that wires them together.

Notes:
- The web package is intentionally not published to npm. Consumers should install it from this GitHub repo (via vendoring/submodule + local path dependency).
- `terminal-go` relies on a POSIX PTY (t
## Installested on macOS/Linux).

## Packages
- `terminal-go` (`github.com/floegence/floeterm/terminal-go`): PTY-backed session manager with history buffering, filtering, and working-directory parsing.
- `terminal-web` (`@floegence/floeterm-terminal-web`): TypeScript package exposing `TerminalCore` and `useTerminalInstance` (no UI components).
- `app/`: reference implementation (`app/backend` serves APIs + websockets, `app/web` is a React UI).


Go:
```bash
go get github.com/floegence/floeterm/terminal-go
```

Web (from GitHub, recommended):
```bash
# Option A: git submodule + local path dependency
git submodule add https://github.com/floegence/floeterm.git third_party/floeterm
npm install ./third_party/floeterm/terminal-web

# Build once (the package exports `dist/`)
cd third_party/floeterm/terminal-web
npm ci
npm run build
```

## Quick Start

Go:
```go
package main

import (
    "log"

    "github.com/floegence/floeterm/terminal-go"
)

func main() {
    manager := terminal.NewManager(terminal.ManagerConfig{})
    session, err := manager.CreateSession("", "", 80, 24)
    if err != nil {
        log.Fatal(err)
    }

    if err := session.WriteDataWithSource([]byte("ls\n"), ""); err != nil {
        log.Fatal(err)
    }
}
```

Web (React):
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

## Development
- `make run` starts the app server (Go + web UI) on `http://localhost:8080`.
- `make check` runs hard-gated CI checks (Go race tests, govulncheck, npm lint/test, npm audit).

## Third Party Notices
See `THIRD_PARTY_NOTICES.md`.

## License
MIT. See `LICENSE`.
