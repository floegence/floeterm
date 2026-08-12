//go:build darwin || linux

package terminal

import (
	"bytes"
	"crypto/sha256"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestRealPTYIdleResizeOrdersFullScreenRedrawAndClose(t *testing.T) {
	const readyMarker = "FLOETERM_FULLSCREEN_READY"
	const pendingMarker = "FLOETERM_KERNEL_PENDING_OLD"
	const frameMarker = "FLOETERM_FULLSCREEN_FRAME"
	command := exec.Command("/bin/sh", "-c", `
frame() {
  size=$(stty size)
  printf '\033[?1049h\033[?25l\033[2J\033[H'
  printf '\033[1;32mFLOETERM_FULLSCREEN_FRAME size=%s\033[0m\r\n' "$size"
  printf '\033[2;4r\033[2;1Hrow-2\033[K\033[3;1Hunicode: 中é🙂\033[K'
  printf '\033[r\033[4;1Hcursor-final\033[?25h'
}
trap frame WINCH
trap 'printf '"'"'FLOETERM_KERNEL_PENDING_OLD\r\n'"'"'' USR1
printf 'FLOETERM_FULLSCREEN_READY\r\n'
while IFS= read -r line; do
  [ "$line" = exit ] && break
done
`)
	master, err := pty.StartWithSize(command, buildWinSize(80, 24))
	if err != nil {
		t.Fatalf("start real PTY helper: %v", err)
	}
	monitor, err := newPTYOutputMonitor(master)
	if err != nil {
		_ = master.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("create real PTY monitor: %v", err)
	}
	readFD, err := syscall.Dup(int(master.Fd()))
	if err != nil {
		_ = monitor.Close()
		_ = master.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("duplicate real PTY reader descriptor: %v", err)
	}
	readerWake, resizeWake, err := os.Pipe()
	if err != nil {
		_ = syscall.Close(readFD)
		_ = monitor.Close()
		_ = master.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("create real PTY wake pipe: %v", err)
	}

	events := make(chan TerminalOutputEvent, 64)
	processDone := make(chan struct{})
	readerDone := make(chan struct{})
	session := &Session{
		ID:                   "real-fullscreen-resize",
		PTY:                  master,
		Cmd:                  command,
		isActive:             true,
		connections:          map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		ringBuffer:           NewTerminalRingBuffer(1 << 20),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      80,
		lastAppliedRows:      24,
		geometryGeneration:   1,
		liveAttachments: map[string]liveAttachment{
			"view": {
				generation: 1,
				subscriber: LiveSubscriber{OnOutput: func(event TerminalOutputEvent) bool {
					events <- event
					return true
				}},
			},
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.ptyReaderReady = true
	session.ptyReaderWakeFD = int(resizeWake.Fd())
	go session.readPTYOutput(readFD, readerWake, resizeWake, monitor, processDone, readerDone)

	readyEvents := waitForOutputMarker(t, events, readyMarker)
	session.ptyOrderMu.Lock()
	if err := command.Process.Signal(syscall.SIGUSR1); err != nil {
		session.ptyOrderMu.Unlock()
		t.Fatalf("signal kernel-pending old output: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		pending, pendingErr := monitor.PendingBytes()
		if pendingErr != nil {
			session.ptyOrderMu.Unlock()
			t.Fatalf("inspect kernel-pending old output: %v", pendingErr)
		}
		if pending >= len(pendingMarker) {
			break
		}
		if time.Now().After(deadline) {
			session.ptyOrderMu.Unlock()
			t.Fatal("old output did not become pending in the PTY kernel queue")
		}
		time.Sleep(time.Millisecond)
	}
	resizeResult := make(chan struct {
		geometry TerminalGeometry
		err      error
	}, 1)
	go func() {
		geometry, resizeErr := session.ApplyConnectionSize("view", 120, 40)
		resizeResult <- struct {
			geometry TerminalGeometry
			err      error
		}{geometry: geometry, err: resizeErr}
	}()
	session.ptyOrderMu.Unlock()
	pendingEvents := waitForOutputMarker(t, events, pendingMarker)
	result := <-resizeResult
	geometry, err := result.geometry, result.err
	if err != nil {
		t.Fatalf("resize idle real PTY: %v", err)
	}
	pendingLastSequence := pendingEvents[len(pendingEvents)-1].Sequence
	if geometry.Generation != 2 || geometry.Cols != 120 || geometry.Rows != 40 {
		t.Fatalf("real PTY resize ACK=%+v, want generation 2 at 120x40", geometry)
	}
	for _, event := range pendingEvents {
		if event.Sequence <= geometry.OutputSequenceBoundary {
			if event.Geometry.Generation != 1 || event.Geometry.Cols != 80 || event.Geometry.Rows != 24 {
				t.Fatalf("pre-barrier admitted output geometry=%+v ACK=%+v", event.Geometry, geometry)
			}
		} else if event.Geometry.Generation != 2 || event.Geometry.Cols != 120 || event.Geometry.Rows != 40 {
			t.Fatalf("post-barrier kernel output geometry=%+v ACK=%+v", event.Geometry, geometry)
		}
	}

	frameEvents := waitForOutputMarker(t, events, "cursor-final")
	var frameBytes []byte
	previousSequence := pendingLastSequence
	for _, event := range frameEvents {
		if event.Sequence != previousSequence+1 {
			t.Fatalf("real PTY sequence gap or duplicate: previous=%d current=%d", previousSequence, event.Sequence)
		}
		previousSequence = event.Sequence
		if event.Geometry.Generation != 2 || event.Geometry.Cols != 120 || event.Geometry.Rows != 40 {
			t.Fatalf("post-resize real PTY event geometry=%+v", event.Geometry)
		}
		frameBytes = append(frameBytes, event.Data...)
	}
	if !bytes.Contains(frameBytes, []byte("size=40 120")) {
		t.Fatalf("real PTY helper observed wrong kernel geometry: %q", frameBytes)
	}
	for _, sequence := range []string{frameMarker, "\x1b[?1049h", "\x1b[?25l", "\x1b[2;4r", "\x1b[K", "\x1b[1;32m", "中é🙂", "\x1b[?25h"} {
		if !bytes.Contains(frameBytes, []byte(sequence)) {
			t.Fatalf("real PTY frame missing %q: %q", sequence, frameBytes)
		}
	}

	chunks := session.ringBuffer.ReadAllChunks()
	var historyBytes []byte
	for index, chunk := range chunks {
		if index > 0 && chunk.Sequence != chunks[index-1].Sequence+1 {
			t.Fatalf("history sequence gap or duplicate: previous=%d current=%d", chunks[index-1].Sequence, chunk.Sequence)
		}
		historyBytes = append(historyBytes, chunk.Data...)
	}
	liveBytes := make([]byte, 0, len(historyBytes))
	for _, event := range append(append(readyEvents, pendingEvents...), frameEvents...) {
		liveBytes = append(liveBytes, event.Data...)
	}
	if sha256.Sum256(liveBytes) != sha256.Sum256(historyBytes) {
		t.Fatalf("real PTY live/history bytes differ: live=%q history=%q", liveBytes, historyBytes)
	}

	close(processDone)
	_ = master.Close()
	select {
	case <-readerDone:
	case <-time.After(2 * time.Second):
		t.Fatal("real PTY reader did not stop after close")
	}
	if command.Process != nil {
		_ = command.Process.Kill()
	}
	_ = command.Wait()
}

func waitForOutputMarker(t *testing.T, events <-chan TerminalOutputEvent, marker string) []TerminalOutputEvent {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	var received []TerminalOutputEvent
	var output strings.Builder
	for {
		select {
		case event := <-events:
			received = append(received, event)
			output.Write(event.Data)
			if strings.Contains(output.String(), marker) {
				return received
			}
		case <-deadline.C:
			t.Fatalf("timeout waiting for output marker %q; output=%q", marker, output.String())
		}
	}
}
