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

Use `ActivateSessionContext` in request-scoped attach paths. Concurrent callers
join one session-owned activation. Cancelling one caller stops only that wait;
`DeleteSession`, `Close`, and `Cleanup` cancel the shared activation and reject
any late PTY result without blocking on shell preparation.

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
    HistoryBufferMaxChunks: 8192,
    HistoryBufferMaxBytes: 8 * 1024 * 1024,
})

diagnostics := manager.GetDiagnostics()
_ = diagnostics.SessionCount
_ = diagnostics.HistoryBytes
```

`HistoryBufferSize` is the initial allocation. `HistoryBufferMaxChunks` may be larger to let the buffer grow on demand without charging dormant or small-history sessions for the maximum slot array. It defaults to `HistoryBufferSize`, preserving fixed-capacity behavior. `HistoryBufferMaxBytes` set to zero preserves chunk-only retention. A single oversized chunk is retained whole rather than slicing an ANSI or OSC sequence. Diagnostics are observational and never reject session creation.

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

Each enabled Bash or Zsh activation validates the generated shared init against
the current contract bytes, creates a `0700` session-private bootstrap with a
`0600` rc file, and places a private random nonce in a non-exported, read-only
shell variable. The nonce is never added to process arguments or environment
variables and the shared init contains no session credential. Shared init files
are installed by same-directory atomic rename and symbolic-link targets are
rejected. Native system startup files still run in their platform-defined order
and remain part of the trusted local-shell boundary. Repeated init loads do not
re-run user configuration or duplicate hooks.

Authentication starts in a pending compatibility state. Only the nonce-matched
`integration_ready` marker emitted after hook installation advances the session
to authenticated mode and removes the private bootstrap. Missing, stale,
truncated, modified, or unloadable integration files never authenticate; while
pending, ordinary lifecycle markers retain legacy behavior so an SSH candidate
cannot become permanently pinned. An authenticated session never silently
downgrades. Fish, POSIX, custom providers, and unknown fallback shells never
receive a nonce and always retain legacy lifecycle behavior.
For those authenticated sessions, while an execution-context frame reports a
remote location, unauthenticated prompt, command, and program markers from PTY
output cannot end or replace the foreground epoch. This keeps a remote location
monotonic until the local shell hook observes the real command exit; a remote
program cannot restore local context by printing forged OSC 133/633 lifecycle
text.

Enabled shells also report a bounded foreground-command snapshot through
`TerminalSessionInfo.ForegroundCommand`. The phase is `unknown`, `idle`, or
`running`; a running snapshot may include a sanitized executable basename such
as `top`. It never contains arguments, environment values, a PID, or the raw
command line. The monotonic command revision lets hosts reject stale metadata
notifications while keeping name and working-directory updates independent.

The same session snapshot includes independent `OutputActivity` metadata with
`unknown`, `streaming`, and `settled` phases. `settled` means the same foreground
command is still running but visible PTY output has been quiet for the configured
interval; it does not mean that the command, Agent turn, or task completed. Set
`ManagerConfig.OutputActivityQuietDuration` to tune the interval; the default is
3.5 seconds.

Implement `TerminalSessionMetadataEventHandler` in addition to
`TerminalEventHandler` to receive command boundary changes without polling.
Implement the optional `TerminalOutputActivityEventHandler` to receive only
low-frequency output phase boundaries; steady streaming output resets one
session timer without publishing one metadata event per PTY chunk.
Implement `TerminalExecutionContextEventHandler` and
`TerminalSemanticWorkStateEventHandler` for their independent revision streams;
context/work changes do not widen the legacy command-metadata callback.
The state is owned by the session and remains available from `ListSessions`
even when no renderer is attached or the originating OSC marker has fallen out
of retained history. This is interactive-shell lifecycle state, not an
operating-system foreground-process probe.

`TerminalSessionInfo.ExecutionContext` independently describes the display-only
location and long-lived application. A foreground `ssh` basename creates a
`remote/opening` candidate; a valid remote OSC 7 authority or strict
`FloetermContext=v1` marker can advance it to `remote/ready`. Remote paths remain
inside `ExecutionContext.Location.WorkingDirectory` and never overwrite the
session's local `WorkingDir` or `Name`. Standard OSC 0/2/7 controls remain in the
PTY stream for renderer compatibility and do not count as display output.
Local context markers and a pop that would remove the final remote frame are
also rejected while any active context frame owns a remote location. Nested
pops that retain a remote parent remain valid. The remote floor is released
only when the authenticated local shell lifecycle closes the foreground epoch.
Legacy Fish, POSIX, and unknown-shell sessions continue to accept their normal
local completion markers so a remote candidate cannot become permanently pinned.

Structured producers may publish `FloetermWork=v1` for an active, topmost Agent
context frame. Accepted work snapshots are stamped with the current context and
foreground-command revisions. Unknown fields, stale or reused frame IDs,
out-of-order stack operations, producer-supplied revisions, and payloads over
the 4 KiB framing limit fail closed. Context, title, path, identity, and work
values are untrusted presentation metadata and must not drive filesystem,
network, authentication, or authorization decisions.

Custom `ShellInitWriter` implementations that also need to run without a PATH prepend can implement `ShellInitRequirement`. Existing writers keep the previous PATH-triggered behavior.

## Notes
- Implement `TerminalEventHandler` to receive output and lifecycle events.
- `CreateSession` is dormant-first; start the PTY with the real viewport through `ActivateSession` or the caller-cancellable `ActivateSessionContext`.
- Configure defaults via `ManagerConfig` (history buffer size, env, and filters). The legacy resize suppression duration fields are deprecated; resize never drops terminal history.
- PTYs start at the effective attached viewport, preserve their last size after the final detach, and skip redundant same-size resizes.
- Working-directory tracking prefers explicit OSC cwd signals (`633;P;Cwd=...`, `1337;CurrentDir=...`, and local `OSC 7 file://...`) and ignores generic title-only OSC updates. Remote OSC 7 paths are display-only execution context.
- Cwd parsing is stream-safe across PTY read chunks, so fragmented fullscreen/TUI control sequences do not trigger false working-directory parse failures.
- Shell metadata parsing is bounded to 4 KiB of pending data. Program labels use a strict 64-byte ASCII allowlist, and ordinary PTY output publishes only output phase boundaries rather than one metadata update per chunk.
- `NewStdLogger` colorizes output by level when writing to a TTY (disable via `NO_COLOR=1` or `FLOETERM_LOG_COLOR=0`).
