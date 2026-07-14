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

## Bounded history replay

Use `GetHistoryPage` when forwarding terminal history over transports with frame or payload limits:

```go
page, err := session.GetHistoryPage(terminal.HistoryPageOptions{
    StartSeq:    1,
    LimitChunks: 256,
    MaxBytes:    384 * 1024,
})
if err != nil {
    // handle error
}

for _, chunk := range page.Chunks {
    _ = chunk
}
if page.HasMore {
    next, err := session.GetHistoryPage(terminal.HistoryPageOptions{
        StartSeq:          page.NextStartSeq,
        EndSeq:            page.SnapshotEndSequence,
        HistoryGeneration: page.HistoryGeneration,
        LimitChunks:       256,
        MaxBytes:          384 * 1024,
    })
    _ = next
    _ = err
}
```

`SnapshotEndSequence` freezes the committed source high-water captured by the first page, so a busy PTY cannot extend the initial replay forever. Pass it and `HistoryGeneration` to every later page. `CoveredThroughSequence` advances through retained or explicitly filtered source sequences even when a configured history filter removes every renderable chunk from a page. Hosts that attach a live client should use `AddConnectionWithHistoryBoundary`: the returned sequence is captured atomically with connection registration, belongs to initial history, and lets the host route only later sequences to that client's live stream.

Check `HistoryReset` and `HistoryTruncated` before accepting a page. `FirstRetainedSequence` reports the current retention floor even for an empty requested range; a caller must rebase rather than treating evicted output as a normal sparse sequence. `ClearHistory` advances the generation without resetting the live source sequence.

Retained history can be bounded by both chunk count and bytes without limiting the number of terminal sessions:

```go
manager := terminal.NewManager(terminal.ManagerConfig{
    HistoryBufferSize:     2048,
    HistoryBufferMaxBytes: 8 * 1024 * 1024,
})

diagnostics := manager.GetDiagnostics()
_ = diagnostics.SessionCount
_ = diagnostics.HistoryBytes
```

`HistoryBufferMaxBytes` set to zero preserves the existing chunk-only behavior. A single oversized chunk is retained whole rather than slicing an ANSI or OSC sequence. Diagnostics are observational and never reject session creation.

## Command lifecycle shell integration

Hosts can enable OSC 633 prompt, command, exit-status, and working-directory markers without maintaining product-specific shell scripts:

```go
writer := terminal.DefaultShellInitWriter{
    BaseDir:                cacheDir,
    EnableCommandLifecycle: true,
}
args := terminal.DefaultShellArgsProvider{
    ShellInitBaseDir:       cacheDir,
    EnableCommandLifecycle: true,
}
```

Lifecycle mode works even when no PATH prepend is required. Bash, Zsh, and Fish receive native hooks; POSIX fallback shells retain their original profile behavior without unsafe command-hook emulation.

Custom `ShellInitWriter` implementations that also need to run without a PATH prepend can implement `ShellInitRequirement`. Existing writers keep the previous PATH-triggered behavior.

## Notes
- Implement `TerminalEventHandler` to receive output and lifecycle events.
- `CreateSession` is dormant-first; start the PTY with the real viewport through `ActivateSession`.
- Configure defaults via `ManagerConfig` (history buffer size, env, and filters). The legacy resize suppression duration fields are deprecated; resize never drops terminal history.
- PTYs start at the effective attached viewport, preserve their last size after the final detach, and skip redundant same-size resizes.
- Working-directory tracking prefers explicit OSC cwd signals (`633;P;Cwd=...`, `1337;CurrentDir=...`, and `OSC 7 file://...`) and ignores generic title-only OSC updates.
- Cwd parsing is stream-safe across PTY read chunks, so fragmented fullscreen/TUI control sequences do not trigger false working-directory parse failures.
- `NewStdLogger` colorizes output by level when writing to a TTY (disable via `NO_COLOR=1` or `FLOETERM_LOG_COLOR=0`).
