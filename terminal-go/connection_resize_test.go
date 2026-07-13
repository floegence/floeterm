package terminal

import (
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestConnectionResizeDeduplicatesAndPreservesDetachedSize(t *testing.T) {
	var calls []*pty.Winsize
	var callsMu sync.Mutex
	session := &Session{
		ID:              "resize-dedup",
		PTY:             &os.File{},
		isActive:        true,
		connections:     make(map[string]*ConnectionInfo),
		lastAppliedCols: 80,
		lastAppliedRows: 24,
		setPTYSize: func(_ *os.File, size *pty.Winsize) error {
			callsMu.Lock()
			defer callsMu.Unlock()
			copySize := *size
			calls = append(calls, &copySize)
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.AddConnection("c1", 80, 24)
	session.UpdateConnectionSize("c1", 80, 24)
	waitForResizeIdle(t, session)
	callsMu.Lock()
	callCount := len(calls)
	callsMu.Unlock()
	if callCount != 0 {
		t.Fatalf("same dimensions triggered %d resize calls", callCount)
	}
	session.UpdateConnectionSize("c1", 120, 40)
	waitForResizeCalls(t, &callsMu, &calls, 1)
	waitForResizeIdle(t, session)
	callsMu.Lock()
	if len(calls) != 1 || calls[0].Cols != 120 || calls[0].Rows != 40 {
		callsMu.Unlock()
		t.Fatalf("unexpected resize calls: %+v", calls)
	}
	callsMu.Unlock()
	session.RemoveConnection("c1")
	waitForResizeIdle(t, session)
	callsMu.Lock()
	callCount = len(calls)
	callsMu.Unlock()
	session.mu.RLock()
	lastCols, lastRows := session.lastAppliedCols, session.lastAppliedRows
	session.mu.RUnlock()
	if callCount != 1 || lastCols != 120 || lastRows != 40 {
		t.Fatalf("detach changed PTY size: calls=%d size=%dx%d", callCount, lastCols, lastRows)
	}
}

func TestConnectionResizeCoalescesRapidUpdates(t *testing.T) {
	var calls []*pty.Winsize
	var callsMu sync.Mutex
	blockFirst := make(chan struct{})
	firstStarted := make(chan struct{})
	session := &Session{
		ID:              "resize-coalesce",
		PTY:             &os.File{},
		isActive:        true,
		connections:     make(map[string]*ConnectionInfo),
		lastAppliedCols: 80,
		lastAppliedRows: 24,
		setPTYSize: func(_ *os.File, size *pty.Winsize) error {
			callsMu.Lock()
			copySize := *size
			calls = append(calls, &copySize)
			first := len(calls) == 1
			callsMu.Unlock()
			if first {
				close(firstStarted)
				<-blockFirst
			}
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.AddConnection("c1", 90, 30)
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first resize did not start")
	}
	session.UpdateConnectionSize("c1", 100, 35)
	session.UpdateConnectionSize("c1", 120, 40)
	close(blockFirst)
	waitForResizeCalls(t, &callsMu, &calls, 2)

	callsMu.Lock()
	defer callsMu.Unlock()
	if calls[0].Cols != 90 || calls[1].Cols != 120 || calls[1].Rows != 40 {
		t.Fatalf("rapid updates were not coalesced to the latest size: %+v", calls)
	}
}

func waitForResizeCalls(t *testing.T, mu *sync.Mutex, calls *[]*pty.Winsize, expected int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := len(*calls)
		mu.Unlock()
		if count >= expected {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d resize calls", expected)
}

func waitForResizeIdle(t *testing.T, session *Session) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		session.mu.RLock()
		idle := !session.resizeRunning && !session.resizeQueued
		session.mu.RUnlock()
		if idle {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for resize reconciler to become idle")
}

func TestConnectionResizeRetriesAfterFailure(t *testing.T) {
	attempts := 0
	session := &Session{
		ID:              "resize-retry",
		PTY:             &os.File{},
		isActive:        true,
		connections:     map[string]*ConnectionInfo{"c1": {ConnID: "c1", Cols: 100, Rows: 30}},
		lastAppliedCols: 80,
		lastAppliedRows: 24,
		setPTYSize: func(_ *os.File, _ *pty.Winsize) error {
			attempts++
			if attempts == 1 {
				return errors.New("temporary failure")
			}
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	if err := session.resizePTYToMinimumSize(); err == nil {
		t.Fatal("expected first resize to fail")
	}
	if session.lastAppliedCols != 80 || session.lastAppliedRows != 24 {
		t.Fatalf("failed resize changed last applied size: %dx%d", session.lastAppliedCols, session.lastAppliedRows)
	}
	if err := session.resizePTYToMinimumSize(); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	if attempts != 2 || session.lastAppliedCols != 100 || session.lastAppliedRows != 30 {
		t.Fatalf("unexpected retry result: attempts=%d size=%dx%d", attempts, session.lastAppliedCols, session.lastAppliedRows)
	}
}
