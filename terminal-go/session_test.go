package terminal

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
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

func (h *captureHandler) OnTerminalData(sessionID string, event TerminalOutputEvent) {
	if len(event.Data) == 0 {
		return
	}
	copyData := make([]byte, len(event.Data))
	copy(copyData, event.Data)
	h.dataCh <- copyData
}

func (h *captureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *captureHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *captureHandler) OnTerminalSessionClosed(string)                       {}
func (h *captureHandler) OnTerminalError(string, error)                        {}

type sequenceCaptureHandler struct {
	sequenceCh chan int64
}

func (h *sequenceCaptureHandler) OnTerminalData(sessionID string, event TerminalOutputEvent) {
	h.sequenceCh <- event.Sequence
}
func (h *sequenceCaptureHandler) OnTerminalNameChanged(string, string, string, string) {}
func (h *sequenceCaptureHandler) OnTerminalSessionCreated(*Session)                    {}
func (h *sequenceCaptureHandler) OnTerminalSessionClosed(string)                       {}
func (h *sequenceCaptureHandler) OnTerminalError(string, error)                        {}

type dropSequenceHistoryFilter struct {
	sequence int64
}

func (f dropSequenceHistoryFilter) Filter(chunks []TerminalDataChunk) []TerminalDataChunk {
	out := make([]TerminalDataChunk, 0, len(chunks))
	for _, chunk := range chunks {
		if chunk.Sequence == f.sequence {
			continue
		}
		out = append(out, chunk)
	}
	return out
}

func TestSessionHistoryAndLiveOutputShareSequence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	handler := &sequenceCaptureHandler{sequenceCh: make(chan int64, 1)}
	session := &Session{
		ID:                "session-seq",
		Name:              "seq",
		WorkingDir:        "/",
		CreatedAt:         time.Now(),
		LastActive:        time.Now(),
		ctx:               ctx,
		cancel:            cancel,
		connections:       make(map[string]*ConnectionInfo),
		ringBuffer:        NewTerminalRingBuffer(8),
		currentWorkingDir: "/",
		eventHandler:      handler,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.processRawPTYData([]byte("hello"))

	var liveSeq int64
	select {
	case liveSeq = <-handler.sequenceCh:
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for live sequence")
	}

	history, err := session.GetHistoryFromSequence(1)
	if err != nil {
		t.Fatalf("failed to read history: %v", err)
	}
	if len(history) != 1 {
		t.Fatalf("expected one history chunk, got %d", len(history))
	}
	if history[0].Sequence != liveSeq {
		t.Fatalf("history sequence %d does not match live sequence %d", history[0].Sequence, liveSeq)
	}
}

func TestSessionAddConnectionReturnsAtomicHistoryBoundary(t *testing.T) {
	session := &Session{
		ID:                "session-boundary",
		connections:       make(map[string]*ConnectionInfo),
		ringBuffer:        NewTerminalRingBuffer(8),
		historyGeneration: 1,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.processRawPTYData([]byte("before"))

	boundary := session.AddConnectionWithHistoryBoundary("client", 80, 24)
	if boundary != 1 {
		t.Fatalf("history boundary=%d, want 1", boundary)
	}
	if _, ok := session.connections["client"]; !ok {
		t.Fatal("connection was not registered with the boundary")
	}

	session.processRawPTYData([]byte("after"))
	page, err := session.GetHistoryPage(HistoryPageOptions{EndSeq: boundary})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Chunks) != 1 || page.Chunks[0].Sequence != 1 || page.SnapshotEndSequence != 1 {
		t.Fatalf("initial history crossed attach boundary: %+v", page)
	}
}

func TestSessionLiveAttachmentReturnsBoundaryAndReceivesOnlyLaterOutput(t *testing.T) {
	session := &Session{
		ID:                "session-live-boundary",
		connections:       make(map[string]*ConnectionInfo),
		liveAttachments:   make(map[string]liveAttachment),
		ringBuffer:        NewTerminalRingBuffer(8),
		historyGeneration: 1,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.processRawPTYData([]byte("before"))
	events := make(chan TerminalOutputEvent, 1)
	attachment, err := session.AttachLiveConnection("client", 1, 80, 24, LiveSubscriber{
		OnOutput: func(event TerminalOutputEvent) bool {
			events <- event
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer attachment.Detach()
	if attachment.HistoryBoundarySequence != 1 || attachment.HistoryGeneration != 1 || attachment.HistoryStartSequence != 1 {
		t.Fatalf("attachment = %+v", attachment)
	}

	session.processRawPTYData([]byte("after"))
	select {
	case event := <-events:
		if event.Sequence != 2 || string(event.Data) != "after" {
			t.Fatalf("event = %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("live subscriber did not receive post-boundary output")
	}
}

func TestSessionSameSizeAttachRequestsFreshFrameAfterHistoryEviction(t *testing.T) {
	redrawCalls := 0
	session := &Session{
		ID:                   "session-truncated-full-screen-redraw",
		PTY:                  &os.File{},
		isActive:             true,
		connections:          make(map[string]*ConnectionInfo),
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(3),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      120,
		lastAppliedRows:      40,
		geometryGeneration:   7,
		setPTYSize:           func(*os.File, *pty.Winsize) error { return nil },
		requestPTYRedraw:     func(*os.File) error { redrawCalls++; return nil },
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		currentWorkingDir:    "/",
	}

	for _, output := range [][]byte{
		[]byte("\x1b[?1049h\x1b[2J\x1b[Htop initial full frame"),
		[]byte("\x1b[Htop delta one"),
		[]byte("\x1b[2;1Htop delta two"),
		[]byte("\x1b[3;1Htop delta three"),
		[]byte("\x1b[4;1Htop delta four"),
	} {
		session.processRawPTYData(output)
	}

	events := make(chan TerminalOutputEvent, 1)
	attachment, err := session.AttachLiveConnection("client", 1, 120, 40, LiveSubscriber{
		OnOutput: func(event TerminalOutputEvent) bool {
			events <- event
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer attachment.Detach()
	if attachment.HistoryBoundarySequence != 5 {
		t.Fatalf("history boundary=%d, want 5", attachment.HistoryBoundarySequence)
	}

	page, err := session.GetHistoryPage(HistoryPageOptions{
		StartSeq: 1,
		EndSeq:   attachment.HistoryBoundarySequence,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !page.HistoryTruncated || page.FirstRetainedSequence != 3 {
		t.Fatalf("expected evicted full-screen bootstrap, got %+v", page)
	}
	if len(page.Chunks) != 3 || page.Chunks[0].Sequence != 3 {
		t.Fatalf("unexpected retained history: %+v", page.Chunks)
	}

	geometry, err := session.ApplyConnectionSize("client", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	if redrawCalls != 1 {
		t.Fatalf("same-size attach redraw calls=%d, want 1", redrawCalls)
	}
	if geometry.Generation != 7 || geometry.OutputSequenceBoundary != attachment.HistoryBoundarySequence {
		t.Fatalf("same-size geometry=%+v, attachment=%+v", geometry, attachment)
	}

	freshFrame := []byte("\x1b[?1049h\x1b[2J\x1b[Htop fresh full frame")
	session.processRawPTYData(freshFrame)
	select {
	case event := <-events:
		if event.Sequence != attachment.HistoryBoundarySequence+1 || !bytes.Equal(event.Data, freshFrame) {
			t.Fatalf("post-boundary redraw event=%+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("live subscriber did not receive the post-boundary full redraw")
	}
}

func TestSessionOutputCarriesTheAppliedTerminalGeometry(t *testing.T) {
	var received TerminalOutputEvent
	session := &Session{
		ID:                   "geometry-output",
		connections:          make(map[string]*ConnectionInfo),
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(8),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      100,
		lastAppliedRows:      30,
		geometryGeneration:   4,
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.liveAttachments["view"] = liveAttachment{
		generation: 1,
		subscriber: LiveSubscriber{OnOutput: func(event TerminalOutputEvent) bool {
			received = event
			return true
		}},
	}

	session.processRawPTYData([]byte("hello"))
	if received.Geometry.Generation != 4 || received.Geometry.Cols != 100 || received.Geometry.Rows != 30 {
		t.Fatalf("output geometry = %+v", received.Geometry)
	}

	session.lastAppliedCols = 120
	session.lastAppliedRows = 40
	session.geometryGeneration = 5
	session.processRawPTYData([]byte("after-resize"))

	history, err := session.GetHistoryFromSequence(1)
	if err != nil {
		t.Fatalf("failed to read history: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("history len=%d, want 2", len(history))
	}
	if history[0].GeometryGeneration != 4 || history[0].Cols != 100 || history[0].Rows != 30 {
		t.Fatalf("first history geometry = %+v", history[0])
	}
	if history[1].GeometryGeneration != 5 || history[1].Cols != 120 || history[1].Rows != 40 {
		t.Fatalf("second history geometry = %+v", history[1])
	}
}

func TestSessionQueuedOutputRetainsTheGeometryCapturedAtPTYRead(t *testing.T) {
	oldGeometry := TerminalGeometry{Generation: 4, Cols: 195, Rows: 60}
	var received TerminalOutputEvent
	session := &Session{
		ID:                   "queued-geometry-output",
		connections:          make(map[string]*ConnectionInfo),
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(8),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      105,
		lastAppliedRows:      60,
		geometryGeneration:   5,
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.liveAttachments["view"] = liveAttachment{
		generation: 1,
		subscriber: LiveSubscriber{OnOutput: func(event TerminalOutputEvent) bool {
			received = event
			return true
		}},
	}

	session.processRawPTYDataAtGeometry([]byte("old-grid-delta"), oldGeometry)
	if received.Geometry != oldGeometry {
		t.Fatalf("live geometry=%+v, want captured %+v", received.Geometry, oldGeometry)
	}
	history, err := session.GetHistoryFromSequence(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 {
		t.Fatalf("history len=%d, want 1", len(history))
	}
	if history[0].GeometryGeneration != oldGeometry.Generation ||
		history[0].Cols != oldGeometry.Cols || history[0].Rows != oldGeometry.Rows {
		t.Fatalf("history geometry=%+v, want captured %+v", history[0], oldGeometry)
	}
}

func TestLiveAttachmentsReceiveEveryEffectiveGeometryChange(t *testing.T) {
	firstGeometry := make(chan TerminalGeometry, 2)
	secondGeometry := make(chan TerminalGeometry, 1)
	session := &Session{
		ID:                 "geometry-broadcast",
		PTY:                &os.File{},
		isActive:           true,
		connections:        make(map[string]*ConnectionInfo),
		liveAttachments:    make(map[string]liveAttachment),
		ringBuffer:         NewTerminalRingBuffer(8),
		historyGeneration:  1,
		lastAppliedCols:    120,
		lastAppliedRows:    40,
		geometryGeneration: 1,
		setPTYSize: func(_ *os.File, _ *pty.Winsize) error {
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	first, err := session.AttachLiveConnection("first", 1, 120, 40, LiveSubscriber{
		OnOutput: func(TerminalOutputEvent) bool { return true },
		OnGeometry: func(geometry TerminalGeometry) bool {
			firstGeometry <- geometry
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Detach()

	second, err := session.AttachLiveConnection("second", 1, 80, 24, LiveSubscriber{
		OnOutput: func(TerminalOutputEvent) bool { return true },
		OnGeometry: func(geometry TerminalGeometry) bool {
			secondGeometry <- geometry
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.Geometry.Generation != 2 || second.Geometry.Cols != 80 || second.Geometry.Rows != 24 {
		t.Fatalf("second attachment geometry = %+v", second.Geometry)
	}
	if geometry := <-firstGeometry; geometry != second.Geometry {
		t.Fatalf("first geometry = %+v, want %+v", geometry, second.Geometry)
	}
	if geometry := <-secondGeometry; geometry != second.Geometry {
		t.Fatalf("second geometry = %+v, want %+v", geometry, second.Geometry)
	}

	second.Detach()
	restored := <-firstGeometry
	if restored.Generation != 3 || restored.Cols != 120 || restored.Rows != 40 {
		t.Fatalf("restored geometry = %+v", restored)
	}
}

func TestSessionWritesIdenticalRapidInputExactlyOncePerCall(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	session := &Session{
		ID:     "session-input-order",
		PTY:    writer,
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	if err := session.WriteDataWithSource([]byte("x"), "client"); err != nil {
		t.Fatal(err)
	}
	if err := session.WriteDataWithSource([]byte("x"), "client"); err != nil {
		t.Fatal(err)
	}

	readDone := make(chan []byte, 1)
	go func() {
		data := make([]byte, 2)
		_, _ = io.ReadFull(reader, data)
		readDone <- data
	}()
	select {
	case data := <-readDone:
		if string(data) != "xx" {
			t.Fatalf("pty data = %q", data)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("second identical input was suppressed")
	}
}

func TestSessionWritesAcceptedInputCompletelyAcrossShortPTYWrites(t *testing.T) {
	payload := []byte("printf '\\033[3J\\033[2J\\033[H'; printf 'FLOETERM_WRAP_'; printf '%180s' '' | tr ' ' X; printf '_END\\n'\r")
	var written bytes.Buffer
	writes := 0
	session := &Session{
		ID:  "session-short-input-write",
		PTY: &os.File{},
		writePTY: func(data []byte) (int, error) {
			writes++
			return written.Write(data[:min(7, len(data))])
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	if err := session.WriteDataWithSource(payload, "client"); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(written.Bytes(), payload) {
		t.Fatalf("PTY input = %q, want complete %q", written.Bytes(), payload)
	}
	if writes <= 1 {
		t.Fatalf("PTY write calls = %d, want multiple short writes", writes)
	}
}

func TestSessionFailsClosedWhenPTYWriteMakesNoProgress(t *testing.T) {
	session := &Session{
		ID:       "session-zero-input-write",
		PTY:      &os.File{},
		writePTY: func([]byte) (int, error) { return 0, nil },
		config:   newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	err := session.WriteDataWithSource([]byte("command\r"), "client")
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("zero-progress PTY write error = %v, want %v", err, io.ErrShortWrite)
	}
}

func TestSessionDoesNotRepeatAcceptedPrefixWhenPTYWriteReturnsAnError(t *testing.T) {
	wantErr := errors.New("pty write failed")
	payload := []byte("command\r")
	var written bytes.Buffer
	writes := 0
	session := &Session{
		ID:  "session-partial-error-input-write",
		PTY: &os.File{},
		writePTY: func(data []byte) (int, error) {
			writes++
			accepted := min(3, len(data))
			_, _ = written.Write(data[:accepted])
			return accepted, wantErr
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	err := session.WriteDataWithSource(payload, "client")
	if !errors.Is(err, wantErr) {
		t.Fatalf("partial PTY write error = %v, want %v", err, wantErr)
	}
	if got, want := written.String(), string(payload[:3]); got != want {
		t.Fatalf("accepted PTY input = %q, want exactly-once prefix %q", got, want)
	}
	if writes != 1 {
		t.Fatalf("PTY write calls = %d, want 1 after partial error", writes)
	}
}

func TestSessionFailsClosedWhenPTYWriteReturnsInvalidCount(t *testing.T) {
	for _, testCase := range []struct {
		name string
		n    int
	}{
		{name: "negative", n: -1},
		{name: "beyond input", n: len("command\r") + 1},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			session := &Session{
				ID:       "session-invalid-count-input-write",
				PTY:      &os.File{},
				writePTY: func([]byte) (int, error) { return testCase.n, nil },
				config:   newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
			}

			err := session.WriteDataWithSource([]byte("command\r"), "client")
			if !errors.Is(err, io.ErrShortWrite) {
				t.Fatalf("invalid-count PTY write error = %v, want %v", err, io.ErrShortWrite)
			}
		})
	}
}

func TestSessionHistoryPagePreservesCursorWhenFilterDropsChunks(t *testing.T) {
	session := &Session{
		ID:                "session-filter",
		Name:              "filter",
		WorkingDir:        "/",
		CreatedAt:         time.Now(),
		LastActive:        time.Now(),
		connections:       make(map[string]*ConnectionInfo),
		ringBuffer:        NewTerminalRingBuffer(4),
		currentWorkingDir: "/",
		config: newSessionConfig(ManagerConfig{
			Logger:        NopLogger{},
			HistoryFilter: dropSequenceHistoryFilter{sequence: 1},
		}),
		committedSequence: 2,
		historyGeneration: 1,
	}

	if err := session.ringBuffer.writeOwnedWithSequence([]byte("drop"), 1, 1000, false); err != nil {
		t.Fatalf("write sequence 1 failed: %v", err)
	}
	if err := session.ringBuffer.writeOwnedWithSequence([]byte("keep"), 2, 2000, false); err != nil {
		t.Fatalf("write sequence 2 failed: %v", err)
	}

	firstPage, err := session.GetHistoryPage(HistoryPageOptions{LimitChunks: 1})
	if err != nil {
		t.Fatalf("GetHistoryPage(first) error: %v", err)
	}
	if len(firstPage.Chunks) != 0 {
		t.Fatalf("len(firstPage.Chunks)=%d, want 0 after filter drop", len(firstPage.Chunks))
	}
	if !firstPage.HasMore || firstPage.NextStartSeq != 2 || firstPage.LastSequence != 1 {
		t.Fatalf("unexpected first page cursor metadata: %+v", firstPage)
	}

	secondPage, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: firstPage.NextStartSeq, LimitChunks: 1})
	if err != nil {
		t.Fatalf("GetHistoryPage(second) error: %v", err)
	}
	if len(secondPage.Chunks) != 1 || string(secondPage.Chunks[0].Data) != "keep" {
		t.Fatalf("unexpected second page chunks: %+v", secondPage.Chunks)
	}
	if secondPage.HasMore || secondPage.LastSequence != 2 {
		t.Fatalf("unexpected second page metadata: %+v", secondPage)
	}
}

func TestSessionHistoryPageUsesFixedSnapshotEnd(t *testing.T) {
	session := &Session{
		ID:                "session-snapshot",
		connections:       make(map[string]*ConnectionInfo),
		ringBuffer:        NewTerminalRingBuffer(8),
		historyGeneration: 1,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.processRawPTYData([]byte("one"))
	session.processRawPTYData([]byte("two"))

	first, err := session.GetHistoryPage(HistoryPageOptions{LimitChunks: 1})
	if err != nil {
		t.Fatal(err)
	}
	if first.SnapshotEndSequence != 2 || first.CoveredThroughSequence != 1 || first.HistoryGeneration != 1 {
		t.Fatalf("unexpected first page metadata: %+v", first)
	}

	session.processRawPTYData([]byte("three"))
	second, err := session.GetHistoryPage(HistoryPageOptions{
		StartSeq:          first.NextStartSeq,
		EndSeq:            first.SnapshotEndSequence,
		HistoryGeneration: first.HistoryGeneration,
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.SnapshotEndSequence != 2 || second.CoveredThroughSequence != 2 || len(second.Chunks) != 1 || second.Chunks[0].Sequence != 2 {
		t.Fatalf("second page chased moving tail: %+v", second)
	}
}

func TestSessionClearHistoryPreservesCoverageAndInvalidatesGeneration(t *testing.T) {
	session := &Session{
		ID:                "session-clear-generation",
		connections:       make(map[string]*ConnectionInfo),
		ringBuffer:        NewTerminalRingBuffer(8),
		historyGeneration: 1,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	session.processRawPTYData([]byte("one"))
	before, err := session.GetHistoryPage(HistoryPageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := session.ClearHistory(); err != nil {
		t.Fatal(err)
	}

	reset, err := session.GetHistoryPage(HistoryPageOptions{HistoryGeneration: before.HistoryGeneration})
	if err != nil {
		t.Fatal(err)
	}
	if !reset.HistoryReset || reset.HistoryGeneration != 2 {
		t.Fatalf("expected generation reset, got %+v", reset)
	}

	after, err := session.GetHistoryPage(HistoryPageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Chunks) != 0 || after.CoveredThroughSequence != 1 || after.SnapshotEndSequence != 1 {
		t.Fatalf("clear regressed committed coverage: %+v", after)
	}

	session.processRawPTYData([]byte("two"))
	attachment, err := session.AttachLiveConnection("client", 1, 80, 24, LiveSubscriber{
		OnOutput: func(TerminalOutputEvent) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer attachment.Detach()
	if attachment.HistoryStartSequence != 2 || attachment.HistoryBoundarySequence != 2 {
		t.Fatalf("clear generation attachment = %+v", attachment)
	}
	latest, err := session.GetHistoryPage(HistoryPageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(latest.Chunks) != 1 || latest.Chunks[0].Sequence != 2 || latest.CoveredThroughSequence != 2 {
		t.Fatalf("source sequence did not remain monotonic after clear: %+v", latest)
	}
}

func TestSessionHistoryPageMarksEvictionBetweenPages(t *testing.T) {
	session := &Session{
		ID:                "session-page-eviction",
		connections:       make(map[string]*ConnectionInfo),
		ringBuffer:        NewTerminalRingBuffer(2),
		historyGeneration: 1,
		config:            newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	for _, value := range []string{"one", "two", "three"} {
		session.processRawPTYData([]byte(value))
	}

	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: 3})
	if err != nil {
		t.Fatal(err)
	}
	if !page.HistoryTruncated || page.FirstRetainedSequence != 2 {
		t.Fatalf("expected explicit history eviction, got %+v", page)
	}
}

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
