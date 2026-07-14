package terminal

import (
	"context"
	"errors"
	"testing"
)

func TestManagerListRenameDelete(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
	})

	session, err := manager.CreateSession("", "")
	if err != nil {
		t.Fatalf("create session failed: %v", err)
	}
	if session.IsActive() {
		t.Fatalf("expected session to start dormant")
	}
	if session.PTY != nil || session.Cmd != nil {
		t.Fatalf("expected PTY and command to remain nil before activation")
	}

	sessions := manager.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}

	if err := manager.RenameSession(session.ID, "renamed"); err != nil {
		t.Fatalf("rename failed: %v", err)
	}

	updated, ok := manager.GetSession(session.ID)
	if !ok || updated.GetName() != "renamed" {
		t.Fatalf("rename not applied")
	}

	if err := manager.DeleteSession(session.ID); err != nil {
		t.Fatalf("delete failed: %v", err)
	}
}

func TestDetachedActiveSessionRejectsActivationThroughStaleReference(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: catShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}

	detached, _, removed := manager.detachSession(session.ID)
	if !removed || detached != session {
		t.Fatal("detachSession did not return the active session")
	}
	defer detached.cleanup()
	if err := detached.startPTYContext(context.Background(), 100, 30); !errors.Is(err, errSessionClosed) {
		t.Fatalf("stale activation error = %v, want session closed", err)
	}
}

func TestCleanupDetachRejectsActivationThroughStaleReference(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: catShellArgsProvider{},
	})
	session, err := manager.CreateSession("test", "")
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	if err := manager.ActivateSession(session.ID, 80, 24); err != nil {
		t.Fatalf("ActivateSession failed: %v", err)
	}

	sessions := manager.detachAllSessions()
	if len(sessions) != 1 || sessions[0] != session {
		t.Fatal("detachAllSessions did not return the active session")
	}
	defer session.cleanup()
	if err := session.startPTYContext(context.Background(), 100, 30); !errors.Is(err, errSessionClosed) {
		t.Fatalf("stale activation error = %v, want session closed", err)
	}
}

func TestManagerDoesNotLimitSessionCountAndReportsDiagnostics(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                NopLogger{},
		HistoryBufferMaxBytes: 8,
	})

	for i := 0; i < 100; i++ {
		if _, err := manager.CreateSession("", ""); err != nil {
			t.Fatalf("create session %d failed: %v", i, err)
		}
	}

	diagnostics := manager.GetDiagnostics()
	if diagnostics.SessionCount != 100 {
		t.Fatalf("SessionCount=%d, want 100", diagnostics.SessionCount)
	}
	if len(diagnostics.SessionHistoryBytes) != 100 {
		t.Fatalf("session history entries=%d, want 100", len(diagnostics.SessionHistoryBytes))
	}
}
