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

func TestConnectionResizeUsesTheMinimumDimensionsAcrossDistinctViews(t *testing.T) {
	var calls []*pty.Winsize
	var callsMu sync.Mutex
	session := &Session{
		ID:       "resize-distinct-views",
		PTY:      &os.File{},
		isActive: true,
		connections: map[string]*ConnectionInfo{
			"wide-short":  {ConnID: "wide-short", Cols: 140, Rows: 24},
			"narrow-tall": {ConnID: "narrow-tall", Cols: 80, Rows: 48},
		},
		lastAppliedCols: 120,
		lastAppliedRows: 40,
		setPTYSize: func(_ *os.File, size *pty.Winsize) error {
			callsMu.Lock()
			defer callsMu.Unlock()
			copySize := *size
			calls = append(calls, &copySize)
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	geometry, err := session.ApplyConnectionSize("wide-short", 160, 30)
	if err != nil {
		t.Fatalf("apply wide view size: %v", err)
	}
	if geometry.Cols != 80 || geometry.Rows != 30 {
		t.Fatalf("effective geometry = %+v, want 80x30", geometry)
	}
	callsMu.Lock()
	if len(calls) != 1 || calls[0].Cols != 80 || calls[0].Rows != 30 {
		callsMu.Unlock()
		t.Fatalf("shared PTY did not use independent minimum dimensions: %+v", calls)
	}
	callsMu.Unlock()

	geometry, err = session.ApplyConnectionSize("narrow-tall", 100, 50)
	if err != nil {
		t.Fatalf("apply narrow view size: %v", err)
	}
	if geometry.Cols != 100 || geometry.Rows != 30 {
		t.Fatalf("effective geometry = %+v, want 100x30", geometry)
	}
	callsMu.Lock()
	if len(calls) != 2 || calls[1].Cols != 100 || calls[1].Rows != 30 {
		callsMu.Unlock()
		t.Fatalf("shared PTY did not advance to the new minimum dimensions: %+v", calls)
	}
	callsMu.Unlock()

	session.RemoveConnection("wide-short")
	waitForResizeCalls(t, &callsMu, &calls, 3)
	waitForResizeIdle(t, session)
	callsMu.Lock()
	defer callsMu.Unlock()
	if calls[2].Cols != 100 || calls[2].Rows != 50 {
		t.Fatalf("remaining view size was not restored after detach: %+v", calls)
	}
}

func TestApplyConnectionSizeReturnsOnlyAfterThePTYResizeCompletes(t *testing.T) {
	resizeStarted := make(chan struct{})
	allowResize := make(chan struct{})
	returned := make(chan struct {
		geometry TerminalGeometry
		err      error
	}, 1)
	session := &Session{
		ID:              "resize-ack",
		PTY:             &os.File{},
		isActive:        true,
		connections:     map[string]*ConnectionInfo{"page-a": {ConnID: "page-a", Cols: 80, Rows: 24}},
		lastAppliedCols: 80,
		lastAppliedRows: 24,
		setPTYSize: func(_ *os.File, _ *pty.Winsize) error {
			close(resizeStarted)
			<-allowResize
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	go func() {
		geometry, err := session.ApplyConnectionSize("page-a", 120, 40)
		returned <- struct {
			geometry TerminalGeometry
			err      error
		}{geometry: geometry, err: err}
	}()
	select {
	case <-resizeStarted:
	case <-time.After(time.Second):
		t.Fatal("PTY resize did not start")
	}
	select {
	case result := <-returned:
		t.Fatalf("resize returned before the PTY resize completed: %+v", result)
	default:
	}
	close(allowResize)
	select {
	case result := <-returned:
		if result.err != nil {
			t.Fatalf("resize returned an error: %v", result.err)
		}
		if result.geometry.Cols != 120 || result.geometry.Rows != 40 {
			t.Fatalf("resize returned geometry %+v", result.geometry)
		}
	case <-time.After(time.Second):
		t.Fatal("resize did not return after the PTY resize completed")
	}
}

func TestEffectiveGeometryGenerationChangesOnlyWhenTheSharedPTYChanges(t *testing.T) {
	session := &Session{
		ID:       "geometry-generation",
		PTY:      &os.File{},
		isActive: true,
		connections: map[string]*ConnectionInfo{
			"wide":   {ConnID: "wide", Cols: 120, Rows: 30},
			"narrow": {ConnID: "narrow", Cols: 80, Rows: 50},
		},
		lastAppliedCols:    80,
		lastAppliedRows:    30,
		geometryGeneration: 7,
		setPTYSize: func(_ *os.File, _ *pty.Winsize) error {
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	geometry, err := session.ApplyConnectionSize("wide", 140, 40)
	if err != nil {
		t.Fatal(err)
	}
	if geometry.Generation != 8 || geometry.Cols != 80 || geometry.Rows != 40 {
		t.Fatalf("changed geometry = %+v", geometry)
	}

	geometry, err = session.ApplyConnectionSize("wide", 160, 40)
	if err != nil {
		t.Fatal(err)
	}
	if geometry.Generation != 8 || geometry.Cols != 80 || geometry.Rows != 40 {
		t.Fatalf("unchanged geometry advanced generation: %+v", geometry)
	}
}
