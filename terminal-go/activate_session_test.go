package terminal

import (
	"testing"
	"time"
)

func TestManagerActivateSessionDoesNotDeadlock(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             testShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- manager.ActivateSession(session.ID, 80, 24)
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ActivateSession failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("ActivateSession appears to be deadlocked")
	}

	if !session.IsActive() {
		t.Fatalf("expected session to be active after ActivateSession")
	}
	if session.PTY == nil || session.Cmd == nil {
		t.Fatalf("expected PTY/Cmd to be initialized")
	}

	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}
