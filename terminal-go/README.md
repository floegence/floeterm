# terminal-go

PTY-backed terminal session manager for Go. It handles session lifecycle, history buffering,
history filtering, workdir parsing, and resize coordination.

## Install
```bash
go get github.com/floegence/floeterm/terminal-go
```

## Usage
```go
package main

import "github.com/floegence/floeterm/terminal-go"

func main() {
    manager := terminal.NewManager(terminal.ManagerConfig{})
    session, _ := manager.CreateSession("", "", 80, 24)
    _ = session.WriteDataWithSource([]byte("pwd\n"), "")
}
```

## Notes
- Implement `TerminalEventHandler` to receive output and lifecycle events.
- Configure defaults via `ManagerConfig` (history buffer size, env, filters, and timing).
- `NewStdLogger` colorizes output by level when writing to a TTY (disable via `NO_COLOR=1` or `FLOETERM_LOG_COLOR=0`).
