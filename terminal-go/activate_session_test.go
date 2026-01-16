package terminal

import (
	"context"
	"os"
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

	workingDir, err := os.UserHomeDir()
	if err != nil || workingDir == "" {
		workingDir = "/"
	}

	ctx, cancel := context.WithCancel(context.Background())
	sessionCfg := newSessionConfig(manager.config)
	sessionID := generateSessionID()

	session := &Session{
		ID:                sessionID,
		Name:              "test",
		WorkingDir:        workingDir,
		CreatedAt:         time.Now(),
		LastActive:        time.Now(),
		isActive:          false,
		connections:       make(map[string]*ConnectionInfo),
		ctx:               ctx,
		cancel:            cancel,
		ringBuffer:        NewTerminalRingBuffer(sessionCfg.historyBufferSize),
		currentWorkingDir: workingDir,
		inputWindow:       sessionCfg.inputWindow,
		eventHandler:      nil,
		onExit:            nil,
		config:            sessionCfg,
	}

	manager.mu.Lock()
	manager.sessions[sessionID] = session
	manager.sessionOrder = append(manager.sessionOrder, sessionID)
	manager.mu.Unlock()

	done := make(chan error, 1)
	go func() {
		done <- manager.ActivateSession(sessionID, 80, 24)
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

	if err := manager.DeleteSession(sessionID); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
}
