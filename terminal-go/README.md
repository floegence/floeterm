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
    session, _ := manager.CreateSession("", "")
    _ = manager.ActivateSession(session.ID, 120, 40)
    _ = session.WriteDataWithSource([]byte("pwd\n"), "")
}
```

## Notes
- Implement `TerminalEventHandler` to receive output and lifecycle events.
- `CreateSession` is dormant-first; start the PTY with the real viewport through `ActivateSession`.
- Configure defaults via `ManagerConfig` (history buffer size, env, filters, and timing).
- Working-directory tracking prefers explicit OSC cwd signals (`633;P;Cwd=...`, `1337;CurrentDir=...`, and `OSC 7 file://...`) and ignores generic title-only OSC updates.
- Cwd parsing is stream-safe across PTY read chunks, so fragmented fullscreen/TUI control sequences do not trigger false working-directory parse failures.
- `NewStdLogger` colorizes output by level when writing to a TTY (disable via `NO_COLOR=1` or `FLOETERM_LOG_COLOR=0`).
