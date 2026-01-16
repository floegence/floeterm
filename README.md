# floeterm

Reusable terminal session management for Go and a headless xterm.js core for web clients.

## Packages
- `terminal-go`: PTY-backed session manager with history buffering, filtering, and workdir parsing.
- `terminal-web`: TypeScript library with `TerminalCore` and `useTerminalInstance` for xterm.js data flow.

## Install

Go:
```bash
go get github.com/floeterm/floeterm/terminal-go
```

Web:
```bash
npm install @floeterm/terminal-web
```

## Quick Start

Go:
```go
package main

import (
    "log"

    "github.com/floeterm/floeterm/terminal-go"
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
import { useTerminalInstance } from '@floeterm/terminal-web';

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
- See `docs/design.md` for the extraction plan.
- See `CONTRIBUTING.md` for workflows and test commands.

## License
MIT. See `LICENSE`.
