package terminal

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestManagerClearSessionHistory(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:            NopLogger{},
		ShellResolver:     testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider: testShellArgsProvider{},
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
		connections:       make(map[string]*ConnectionInfo),
		ctx:               ctx,
		cancel:            cancel,
		ringBuffer:        NewTerminalRingBuffer(8),
		currentWorkingDir: workingDir,
		config:            sessionCfg,
	}

	manager.mu.Lock()
	manager.sessions[sessionID] = session
	manager.sessionOrder = append(manager.sessionOrder, sessionID)
	manager.mu.Unlock()

	if err := session.ringBuffer.Write([]byte("hello")); err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if got := session.ringBuffer.ReadAllChunks(); len(got) == 0 {
		t.Fatalf("expected ring buffer to have data before clear")
	}

	if err := manager.ClearSessionHistory(sessionID); err != nil {
		t.Fatalf("ClearSessionHistory failed: %v", err)
	}
	if got := session.ringBuffer.ReadAllChunks(); len(got) != 0 {
		t.Fatalf("expected ring buffer to be empty after clear, got %d chunks", len(got))
	}
}
