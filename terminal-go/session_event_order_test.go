package terminal

import (
	"testing"
	"time"
)

type quickExitShellArgsProvider struct{}

func (quickExitShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	return []string{"-c", "exit 0"}, nil
}

type eventOrderHandler struct {
	events chan string
}

func (h *eventOrderHandler) OnTerminalData(string, []byte, int64, bool, string) {}
func (h *eventOrderHandler) OnTerminalNameChanged(string, string, string, string) {
}

func (h *eventOrderHandler) OnTerminalSessionCreated(*Session) {
	// Make CreateSession slow so the child process can exit before CreateSession returns.
	// Without a "created" barrier, OnTerminalSessionClosed could fire first.
	time.Sleep(200 * time.Millisecond)
	h.events <- "created"
}

func (h *eventOrderHandler) OnTerminalSessionClosed(string) {
	h.events <- "closed"
}

func (h *eventOrderHandler) OnTerminalError(string, error) {}

func TestCreateSessionEmitsCreatedBeforeClosedEvenOnFastExit(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             quickExitShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	events := make(chan string, 2)
	manager.SetEventHandler(&eventOrderHandler{events: events})

	_, err := manager.CreateSession("fast-exit", "", 80, 24)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	var first, second string
	select {
	case first = <-events:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for first event")
	}
	select {
	case second = <-events:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for second event")
	}

	if first != "created" || second != "closed" {
		t.Fatalf("unexpected event order: %q then %q", first, second)
	}
}
