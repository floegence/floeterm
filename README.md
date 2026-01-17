# floeterm

Reusable terminal session management for Go and a headless xterm.js core for web clients.

## Packages
- `terminal-go`: PTY-backed session manager with history buffering, filtering, and workdir parsing.
- `terminal-web`: TypeScript library with `TerminalCore` and `useTerminalInstance` for xterm.js data flow.
- `app/`: a runnable service that wires `terminal-go` and `terminal-web` together (`app/backend` + `app/web`).

## Install

Go:
```bash
go get github.com/floegence/floeterm/terminal-go
```

Web (from GitHub):
```bash
# This repo does not publish npm packages.
# Install by vendoring/cloning the repo and installing from the local path.
git clone https://github.com/floegence/floeterm.git
cd floeterm/terminal-web
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
