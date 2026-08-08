//go:build darwin || linux

package terminal

import (
	"bytes"
	"io"
	"os/exec"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestRequestPTYForegroundRedrawSignalsTheForegroundProcessGroup(t *testing.T) {
	command := exec.Command("/bin/sh", "-c", `
trap 'printf "FLOETERM_REDRAW\n"; exit 0' WINCH
printf "FLOETERM_READY\n"
while :; do read -r line; done
`)
	master, err := pty.Start(command)
	if err != nil {
		t.Fatalf("start PTY command: %v", err)
	}
	t.Cleanup(func() {
		_ = master.Close()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	})

	output := make(chan []byte, 16)
	go func() {
		buffer := make([]byte, 1024)
		for {
			n, readErr := master.Read(buffer)
			if n > 0 {
				output <- append([]byte(nil), buffer[:n]...)
			}
			if readErr != nil {
				if readErr != io.EOF {
					output <- []byte(readErr.Error())
				}
				close(output)
				return
			}
		}
	}()

	waitForPTYMarker(t, output, []byte("FLOETERM_READY"))
	if err := requestPTYForegroundRedraw(master); err != nil {
		t.Fatalf("request foreground redraw: %v", err)
	}
	waitForPTYMarker(t, output, []byte("FLOETERM_REDRAW"))
}

func waitForPTYMarker(t *testing.T, output <-chan []byte, marker []byte) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	var received bytes.Buffer
	for {
		select {
		case chunk, ok := <-output:
			if !ok {
				t.Fatalf("PTY closed before marker %q; output=%q", marker, received.Bytes())
			}
			received.Write(chunk)
			if bytes.Contains(received.Bytes(), marker) {
				return
			}
		case <-deadline.C:
			t.Fatalf("timeout waiting for PTY marker %q; output=%q", marker, received.Bytes())
		}
	}
}
