package terminal

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

type testShellResolver struct{ shell string }

func (r testShellResolver) ResolveShell(Logger) string { return r.shell }

type testShellArgsProvider struct{}

func (testShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	return []string{"-c", "printf 'ready\\n'; cat"}, nil
}

type captureHandler struct {
	dataCh chan []byte
}

func (h *captureHandler) OnTerminalData(sessionID string, data []byte, sequenceNumber int64, isEcho bool, originalSource string) {
	if len(data) == 0 {
		return
	}
	copyData := make([]byte, len(data))
	copy(copyData, data)
	h.dataCh <- copyData
}

func (h *captureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *captureHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *captureHandler) OnTerminalSessionClosed(string)                       {}
func (h *captureHandler) OnTerminalError(string, error)                        {}

func TestSessionLifecycleAndOutput(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             testShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	handler := &captureHandler{dataCh: make(chan []byte, 16)}
	manager.SetEventHandler(handler)

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer session.Close()

	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("failed to activate session: %v", err)
	}

	waitForOutput(t, handler.dataCh, "ready", 2*time.Second)
	time.Sleep(20 * time.Millisecond)

	if err := session.WriteDataWithSource([]byte("ping\n"), "test"); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	waitForOutput(t, handler.dataCh, "ping", 2*time.Second)

	history, err := session.GetHistoryFromSequence(1)
	if err != nil {
		t.Fatalf("failed to get history: %v", err)
	}
	if len(history) == 0 {
		t.Fatalf("expected history to contain data")
	}
}

func TestActivateSessionRespectsConnectionSizesBeforeAndAfterActivation(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             testShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
		ResizeSuppressDuration:        time.Millisecond,
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer session.Close()

	session.AddConnection("c1", 120, 40)
	session.AddConnection("c2", 90, 30)
	session.UpdateConnectionSize("c1", 100, 35)

	if session.IsActive() {
		t.Fatalf("expected session to remain dormant before activation")
	}

	if err := manager.ActivateSession(session.ID, 100, 35); err != nil {
		t.Fatalf("failed to activate session: %v", err)
	}

	waitForPTYSize(t, session, 90, 30, 2*time.Second)

	session.UpdateConnectionSize("c2", 110, 32)
	waitForPTYSize(t, session, 100, 32, 2*time.Second)

	session.RemoveConnection("c1")
	waitForPTYSize(t, session, 110, 32, 2*time.Second)
}

func waitForOutput(t *testing.T, ch <-chan []byte, expected string, timeout time.Duration) {
	t.Helper()

	deadline := time.After(timeout)
	var buf bytes.Buffer

	for {
		select {
		case data := <-ch:
			buf.Write(data)
			if strings.Contains(buf.String(), expected) {
				return
			}
		case <-deadline:
			t.Fatalf("timeout waiting for output %q, got %q", expected, buf.String())
		}
	}
}

func waitForPTYSize(t *testing.T, session *Session, expectedCols, expectedRows int, timeout time.Duration) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		session.mu.RLock()
		ptyFile := session.PTY
		session.mu.RUnlock()
		if ptyFile != nil {
			rows, cols, err := pty.Getsize(ptyFile)
			if err == nil && cols == expectedCols && rows == expectedRows {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}

	t.Fatalf("timeout waiting for PTY size %dx%d", expectedCols, expectedRows)
}
