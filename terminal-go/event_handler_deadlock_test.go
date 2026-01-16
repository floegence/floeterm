package terminal

import (
	"sync"
	"testing"
	"time"
)

type managerReentrantHandler struct {
	manager *Manager
	created chan struct{}
}

func (h *managerReentrantHandler) OnTerminalData(string, []byte, int64, bool, string) {}
func (h *managerReentrantHandler) OnTerminalNameChanged(string, string, string, string) {
}
func (h *managerReentrantHandler) OnTerminalSessionCreated(*Session) {
	// This would deadlock if CreateSession invoked handlers while holding m.mu.
	_ = h.manager.ListSessions()
	select {
	case h.created <- struct{}{}:
	default:
	}
}
func (h *managerReentrantHandler) OnTerminalSessionClosed(string) {}
func (h *managerReentrantHandler) OnTerminalError(string, error)  {}

func TestCreateSessionHandlerDoesNotDeadlock(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             testShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	created := make(chan struct{}, 1)
	manager.SetEventHandler(&managerReentrantHandler{manager: manager, created: created})

	done := make(chan struct{})
	var session *Session
	var err error
	go func() {
		session, err = manager.CreateSession("test", "", 80, 24)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("CreateSession appears to be deadlocked")
	}

	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	if session == nil {
		t.Fatalf("expected session to be non-nil")
	}
	t.Cleanup(func() {
		_ = manager.DeleteSession(session.ID)
	})

	select {
	case <-created:
	default:
		t.Fatalf("expected OnTerminalSessionCreated to run")
	}
}

type dataReentrantHandler struct {
	session *Session

	once  sync.Once
	done  chan struct{}
	errMu sync.Mutex
	err   error
}

func (h *dataReentrantHandler) OnTerminalData(string, []byte, int64, bool, string) {
	h.once.Do(func() {
		// This would deadlock if broadcastData invoked handlers while holding s.mu.
		h.errMu.Lock()
		h.err = h.session.WriteDataWithSource([]byte("ping\n"), "handler")
		h.errMu.Unlock()
		close(h.done)
	})
}

func (h *dataReentrantHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *dataReentrantHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *dataReentrantHandler) OnTerminalSessionClosed(string)                       {}
func (h *dataReentrantHandler) OnTerminalError(string, error)                        {}

type catShellArgsProvider struct{}

func (catShellArgsProvider) GetShellArgs(string, string) ([]string, []string) {
	return []string{"-c", "cat"}, nil
}

func TestOnTerminalDataHandlerMayWriteWithoutDeadlock(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                        NopLogger{},
		ShellResolver:                 testShellResolver{shell: "/bin/sh"},
		ShellArgsProvider:             catShellArgsProvider{},
		InitialResizeSuppressDuration: time.Millisecond,
	})

	handler := &dataReentrantHandler{done: make(chan struct{})}
	manager.SetEventHandler(handler)

	session, err := manager.CreateSession("test", "", 80, 24)
	if err != nil {
		t.Fatalf("CreateSession failed: %v", err)
	}
	handler.session = session
	t.Cleanup(func() {
		_ = manager.DeleteSession(session.ID)
	})

	// Trigger a broadcast that runs the handler.
	session.processRawPTYData([]byte("trigger"))

	select {
	case <-handler.done:
	case <-time.After(2 * time.Second):
		t.Fatal("OnTerminalData handler appears to be deadlocked")
	}

	handler.errMu.Lock()
	defer handler.errMu.Unlock()
	if handler.err != nil {
		t.Fatalf("WriteDataWithSource failed: %v", handler.err)
	}
}
