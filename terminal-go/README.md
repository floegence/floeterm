# terminal-go

PTY-backed semantic terminal session manager for Go. It handles session lifecycle,
native Ghostty VT ownership, canonical geometry, bounded semantic history, workdir
parsing, controller/observer attachment, and semantic Presentation delivery.

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

## Semantic history

History is owned only by the native Ghostty session actor. Call
`ReadSemanticHistory` with the current attachment generation to request a bounded,
owned page. Returned anchors are opaque and attachment-local; they expire when the
view detaches and never expose native pointers, raw PTY replay, or parser state.

A semantic history query is serialized with PTY output, input, and resize without
moving the live viewport or changing the current Presentation. The browser may
project a returned page locally, while the authoritative live frame continues to
arrive through the same semantic transport.

## Semantic clear

Call `Session.ClearSemanticScreen` with the current attachment, principal, and
transport generation for the user-visible clear action. The single native
`SessionActor` resets the VT screen, bounded semantic history, graphics, and tracked
history projections, then publishes one atomic Presentation with a new
`State.ContentEpoch`. Every live view receives that exact Presentation. Stale
generations and unauthorized principals have no effect; a reset or capture failure
fails the session closed rather than returning a forged success. The operation does
not send Ctrl-L or clear a browser canvas.

The live service sends a bounded reliable FIFO for geometry/lifecycle events and one
capacity-one latest Presentation slot. It never sends raw PTY bytes to a browser.
Resize settlement is emitted only after the actor has applied canonical geometry and
captured a matching Presentation.

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
For those authenticated sessions, nonce-less prompt-ready and command-finished
markers from PTY output cannot end a running foreground epoch, including in a
local location. Full-screen programs and Agent CLIs may emit nested OSC 133/633
semantic zones for their own rendered messages; those zones do not replace the
local shell's authoritative lifecycle. While an execution-context frame reports
a remote location, all nonce-less prompt, command, and program markers are
rejected. These rules keep local Agent identity and remote location monotonic
until the authenticated local shell hook observes the real command exit. Fish,
POSIX, custom providers, and unknown fallback shells retain legacy lifecycle
behavior.

Enabled shells also report a bounded foreground-command snapshot through
`TerminalSessionInfo.ForegroundCommand`. The phase is `unknown`, `idle`, or
`running`; a running snapshot may include a sanitized executable basename such
as `top`. It never contains arguments, environment values, a PID, or the raw
command line. The monotonic command revision lets hosts reject stale metadata
notifications while keeping name and working-directory updates independent.

For a statically parseable `ssh` invocation, Bash, Zsh, and Fish additionally
emit only the normalized destination as private command-start metadata. The
destination may seed a display-only `remote/opening` label such as
`root@host.example`; its authority remains empty and it cannot establish
readiness or authorize remote resources. Quoting, expansion, control syntax,
unknown options, and malformed targets fall back to the generic `SSH` label.
The raw command line and arguments are never emitted, logged, or retained as
session metadata. OSC 7 or an explicit context marker remains authoritative for
the confirmed remote location.

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
- Implement `TerminalEventHandler` to receive lifecycle events.
- `CreateSession` is dormant-first; start the PTY with the real viewport through `ActivateSession` or the caller-cancellable `ActivateSessionContext`.
- Configure environment and shell lifecycle defaults through `ManagerConfig`. The legacy resize suppression duration fields are deprecated; resize never drops PTY output.
- PTYs start at the effective attached viewport, preserve their last size after the final detach, and skip redundant same-size resizes.
- Working-directory tracking prefers explicit OSC cwd signals (`633;P;Cwd=...`, `1337;CurrentDir=...`, and local `OSC 7 file://...`) and ignores generic title-only OSC updates. Remote OSC 7 paths are display-only execution context.
- Cwd parsing is stream-safe across PTY read chunks, so fragmented fullscreen/TUI control sequences do not trigger false working-directory parse failures.
- Shell metadata parsing is bounded to 4 KiB of pending data. Program labels use a strict 64-byte ASCII allowlist, and ordinary PTY output publishes only output phase boundaries rather than one metadata update per chunk.
- `NewStdLogger` colorizes output by level when writing to a TTY (disable via `NO_COLOR=1` or `FLOETERM_LOG_COLOR=0`).
