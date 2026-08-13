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

func TestConnectionResizeFixedRapidVectorConvergesToLatestIntent(t *testing.T) {
	vector := [][2]int{{120, 40}, {63, 18}, {160, 52}, {88, 31}, {132, 46}}
	var calls []*pty.Winsize
	var callsMu sync.Mutex
	firstStarted := make(chan struct{})
	allowFirst := make(chan struct{})
	session := &Session{
		ID:              "resize-fixed-vector",
		PTY:             &os.File{},
		isActive:        true,
		connections:     map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
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
				<-allowFirst
			}
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.UpdateConnectionSize("view", vector[0][0], vector[0][1])
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("first vector resize did not start")
	}
	for _, size := range vector[1:] {
		session.UpdateConnectionSize("view", size[0], size[1])
	}
	close(allowFirst)
	waitForResizeCalls(t, &callsMu, &calls, 2)
	waitForResizeIdle(t, session)

	callsMu.Lock()
	defer callsMu.Unlock()
	if len(calls) != 2 || calls[0].Cols != 120 || calls[0].Rows != 40 || calls[1].Cols != 132 || calls[1].Rows != 46 {
		t.Fatalf("fixed resize vector did not coalesce to first/latest: %+v", calls)
	}
	if session.lastAppliedCols != 132 || session.lastAppliedRows != 46 || session.geometryGeneration != 2 {
		t.Fatalf("final geometry=%dx%d generation=%d", session.lastAppliedCols, session.lastAppliedRows, session.geometryGeneration)
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

func TestConnectionResizeReconcilerResizesActorAndPublishesPresentation(t *testing.T) {
	engine := &resizeRecordingEngine{}
	store := NewPresentationStore(8)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	store.Next()
	var presentations []SemanticPresentation
	session := &Session{
		ID: "resize-reconciler-actor", PTY: &os.File{}, isActive: true,
		connections:     map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 120, Rows: 40}},
		lastAppliedCols: 80, lastAppliedRows: 24, geometryGeneration: 1,
		semanticActor: actor, presentationStore: store,
		setPTYSize: func(*os.File, *pty.Winsize) error { return nil },
		config:     newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.liveAttachments = map[string]liveAttachment{"view": {generation: 1, subscriber: LiveSubscriber{
		OnOutput:       func(TerminalOutputEvent) bool { return true },
		OnPresentation: func(p SemanticPresentation) bool { presentations = append(presentations, p); return true },
	}}}
	session.schedulePTYSizeReconcileLocked("test")
	waitForResizeIdle(t, session)
	if engine.resizeCalls != 1 {
		t.Fatalf("actor resize calls=%d, want 1", engine.resizeCalls)
	}
	if len(presentations) != 1 {
		t.Fatalf("presentation notifications=%d, want 1", len(presentations))
	}
	if got := presentations[0]; got.Geometry.Cols != 120 || got.Geometry.Rows != 40 || got.Frame.Width != 120 || got.Frame.Height != 40 {
		t.Fatalf("presentation=%+v frame=%dx%d", got.Geometry, got.Frame.Width, got.Frame.Height)
	}
}

type resizeRecordingEngine struct{ cols, rows, resizeCalls int }

func (e *resizeRecordingEngine) ApplyOutput([]byte) (TerminalState, error) {
	return TerminalState{}, nil
}
func (e *resizeRecordingEngine) CaptureFrame() (SemanticFrame, error) {
	return SemanticFrame{Width: e.cols, Height: e.rows, Rows: make([]SemanticRow, e.rows)}, nil
}
func (e *resizeRecordingEngine) Resize(cols, rows int) error {
	e.cols, e.rows, e.resizeCalls = cols, rows, e.resizeCalls+1
	return nil
}
func (e *resizeRecordingEngine) EncodeInput(SemanticInput) ([]byte, error) { return nil, nil }
func (e *resizeRecordingEngine) Close()                                    {}

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
	resizeCalls := 0
	redrawCalls := 0
	var resizeObservedGeneration uint64
	var session *Session
	session = &Session{
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
			resizeCalls++
			resizeObservedGeneration = session.geometryGeneration
			return nil
		},
		requestPTYRedraw: func(_ *os.File) error {
			redrawCalls++
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
	if resizeCalls != 1 {
		t.Fatalf("changed geometry resize calls = %d", resizeCalls)
	}
	if redrawCalls != 0 {
		t.Fatalf("changed geometry emitted an extra redraw signal: calls=%d", redrawCalls)
	}
	if resizeObservedGeneration != 7 {
		t.Fatalf("PTY ioctl observed generation=%d, want pre-resize generation 7", resizeObservedGeneration)
	}

	geometry, err = session.ApplyConnectionSize("wide", 160, 40)
	if err != nil {
		t.Fatal(err)
	}
	if geometry.Generation != 8 || geometry.Cols != 80 || geometry.Rows != 40 {
		t.Fatalf("unchanged geometry advanced generation: %+v", geometry)
	}
	if resizeCalls != 1 {
		t.Fatalf("unchanged resize repeated the PTY ioctl: calls=%d, want 1 total", resizeCalls)
	}
	if redrawCalls != 0 {
		t.Fatalf("unchanged resize requested a foreground redraw: calls=%d", redrawCalls)
	}
}

func TestForcedSameSizeResizeContinuesWhenForegroundRedrawIsUnavailable(t *testing.T) {
	session := &Session{
		ID:                 "redraw-unavailable",
		PTY:                &os.File{},
		isActive:           true,
		connections:        map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 120, Rows: 40}},
		lastAppliedCols:    120,
		lastAppliedRows:    40,
		geometryGeneration: 9,
		setPTYSize:         func(*os.File, *pty.Winsize) error { return nil },
		requestPTYRedraw:   func(*os.File) error { return errors.New("no foreground process group") },
		config:             newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	geometry, err := session.ApplyConnectionSize("view", 120, 40)
	if err != nil {
		t.Fatalf("same-size resize failed because redraw signal was unavailable: %v", err)
	}
	if geometry.Generation != 9 || geometry.Cols != 120 || geometry.Rows != 40 {
		t.Fatalf("geometry changed after best-effort redraw failure: %+v", geometry)
	}
}

func TestApplyConnectionSizeDeduplicatesAnUnchangedEffectiveGrid(t *testing.T) {
	resizeCalls := 0
	redrawCalls := 0
	session := &Session{
		ID:                 "same-size-no-op",
		PTY:                &os.File{},
		isActive:           true,
		connections:        map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 120, Rows: 40}},
		lastAppliedCols:    120,
		lastAppliedRows:    40,
		geometryGeneration: 9,
		committedSequence:  23,
		setPTYSize: func(*os.File, *pty.Winsize) error {
			resizeCalls++
			return nil
		},
		requestPTYRedraw: func(*os.File) error {
			redrawCalls++
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	geometry, err := session.ApplyConnectionSize("view", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	if resizeCalls != 0 || redrawCalls != 0 {
		t.Fatalf("unchanged effective grid caused ioctl/redraw storm: resize=%d redraw=%d", resizeCalls, redrawCalls)
	}
	if geometry.Generation != 9 || geometry.OutputSequenceBoundary != 23 || geometry.Cols != 120 || geometry.Rows != 40 {
		t.Fatalf("unchanged effective geometry=%+v", geometry)
	}
}
