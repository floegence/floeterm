package terminal

import (
	"bytes"
	"errors"
	"io"
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

type cappedReader struct {
	reader *bytes.Reader
	limit  int
}

type readBarrierReader struct {
	data       []byte
	readReturn chan<- struct{}
	read       bool
}

func (r *readBarrierReader) Read(target []byte) (int, error) {
	if r.read {
		return 0, io.EOF
	}
	r.read = true
	n := copy(target, r.data)
	close(r.readReturn)
	return n, io.EOF
}

func TestPTYReadPacketPrecedesConcurrentResizeBoundary(t *testing.T) {
	oldGeometry := TerminalGeometry{Generation: 4, Cols: 195, Rows: 60}
	packetCaptureStarted := make(chan struct{})
	allowPacketCapture := make(chan struct{})
	reads := make(chan ptyReadResult, 1)
	events := make(chan TerminalOutputEvent, 1)
	readerReturned := make(chan struct{})
	session := &Session{
		ID:       "read-resize-boundary",
		PTY:      &os.File{},
		isActive: true,
		connections: map[string]*ConnectionInfo{
			"view": {ConnID: "view", Cols: oldGeometry.Cols, Rows: oldGeometry.Rows},
		},
		ringBuffer:           NewTerminalRingBuffer(1024),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      oldGeometry.Cols,
		lastAppliedRows:      oldGeometry.Rows,
		geometryGeneration:   oldGeometry.Generation,
		setPTYSize: func(*os.File, *pty.Winsize) error {
			return nil
		},
		eventHandler: &captureHandler{dataCh: make(chan []byte, 1)},
		liveAttachments: map[string]liveAttachment{
			"view": {
				generation: 1,
				subscriber: LiveSubscriber{OnOutput: func(event TerminalOutputEvent) bool {
					events <- event
					return true
				}},
			},
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	go readPTYPacketsWithPendingGeometry(
		&readBarrierReader{data: []byte("old-grid-frame"), readReturn: readerReturned},
		reads,
		func() (int, error) { return 0, nil },
		nil,
		func(buffer []byte) (int, error, TerminalGeometry) {
			return session.readPTYPacketOrdered(buffer, func(target []byte) (int, error) {
				n, err := (&readBarrierReader{data: []byte("old-grid-frame"), readReturn: readerReturned}).Read(target)
				close(packetCaptureStarted)
				<-allowPacketCapture
				return n, err
			}, nil)
		},
	)

	select {
	case <-packetCaptureStarted:
	case <-time.After(time.Second):
		t.Fatal("PTY read did not reach the pre-capture barrier")
	}
	select {
	case <-readerReturned:
	case <-time.After(time.Second):
		t.Fatal("PTY Read did not return before the geometry barrier")
	}
	resizeReturned := make(chan struct {
		geometry TerminalGeometry
		err      error
	}, 1)
	go func() {
		geometry, err := session.ApplyConnectionSize("view", 120, 40)
		resizeReturned <- struct {
			geometry TerminalGeometry
			err      error
		}{geometry: geometry, err: err}
	}()
	select {
	case result := <-resizeReturned:
		t.Fatalf("resize crossed a PTY packet that had already been read: %+v", result)
	default:
	}
	close(allowPacketCapture)

	packet := <-reads
	session.processAdmittedPTYDataAtGeometry(packet.data, packet.geometry)
	event := <-events
	var resizeGeometry TerminalGeometry
	select {
	case result := <-resizeReturned:
		if result.err != nil {
			t.Fatalf("apply concurrent resize: %v", result.err)
		}
		resizeGeometry = result.geometry
	case <-time.After(time.Second):
		t.Fatal("resize did not return after the pre-resize packet committed")
	}

	if packet.geometry != oldGeometry {
		t.Errorf("pre-resize PTY packet geometry=%+v, want old geometry %+v", packet.geometry, oldGeometry)
	}
	if resizeGeometry.OutputSequenceBoundary < event.Sequence {
		t.Fatalf(
			"resize ACK boundary=%d did not cover pre-resize packet sequence=%d",
			resizeGeometry.OutputSequenceBoundary,
			event.Sequence,
		)
	}
}

func (r *cappedReader) Read(target []byte) (int, error) {
	if len(target) > r.limit {
		target = target[:r.limit]
	}
	return r.reader.Read(target)
}

func TestReadPTYPacketsSendsBurstHeadThenCoalescesPendingOutput(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 33*1024)
	reader := &cappedReader{reader: bytes.NewReader(payload), limit: 1024}
	reads := make(chan ptyReadResult, 4)

	readPTYPacketsWithPending(reader, reads, func() (int, error) {
		return reader.reader.Len(), nil
	}, nil)

	first := <-reads
	second := <-reads
	terminal := <-reads
	if len(first.data) != 1024 || first.err != nil {
		t.Fatalf("first result=%d/%v, want 1024/nil", len(first.data), first.err)
	}
	if len(second.data) != 32*1024 || second.err != nil {
		t.Fatalf("second result=%d/%v, want 32768/nil", len(second.data), second.err)
	}
	if len(terminal.data) != 0 || !errors.Is(terminal.err, io.EOF) {
		t.Fatalf("terminal result=%d/%v, want 0/EOF", len(terminal.data), terminal.err)
	}
	if _, ok := <-reads; ok {
		t.Fatal("PTY result channel remained open after EOF")
	}
}

func TestCollectAvailablePTYBurstDrainsOnlyBufferedReads(t *testing.T) {
	reads := make(chan ptyReadResult, 3)
	reads <- ptyReadResult{data: bytes.Repeat([]byte("a"), 1024)}
	reads <- ptyReadResult{data: bytes.Repeat([]byte("b"), 1024)}
	reads <- ptyReadResult{data: bytes.Repeat([]byte("c"), 1024)}
	first := <-reads
	buffer := make([]byte, 32*1024)

	n, pending, _, err := collectAvailablePTYBurst(first, reads, buffer)
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("unexpected pending read: %+v", pending)
	}
	if n != 3*1024 {
		t.Fatalf("read bytes=%d, want %d", n, 3*1024)
	}
	if !bytes.Equal(buffer[:1024], bytes.Repeat([]byte("a"), 1024)) ||
		!bytes.Equal(buffer[1024:2048], bytes.Repeat([]byte("b"), 1024)) ||
		!bytes.Equal(buffer[2048:3072], bytes.Repeat([]byte("c"), 1024)) {
		t.Fatal("buffered PTY reads were not preserved in order")
	}

	empty := make(chan ptyReadResult, 1)
	n, pending, _, err = collectAvailablePTYBurst(
		ptyReadResult{data: bytes.Repeat([]byte("x"), 1024)},
		empty,
		buffer,
	)
	if err != nil || pending != nil || n != 1024 {
		t.Fatalf("empty drain bytes=%d pending=%v error=%v, want 1024/nil/nil", n, pending, err)
	}
}

func TestCollectAvailablePTYBurstStopsAtGeometryBoundary(t *testing.T) {
	oldGeometry := TerminalGeometry{Generation: 4, Cols: 195, Rows: 60}
	newGeometry := TerminalGeometry{Generation: 5, Cols: 105, Rows: 60}
	reads := make(chan ptyReadResult, 1)
	reads <- ptyReadResult{data: []byte("new-grid"), geometry: newGeometry}
	buffer := make([]byte, 32*1024)

	n, pending, geometry, err := collectAvailablePTYBurst(
		ptyReadResult{data: []byte("old-grid"), geometry: oldGeometry},
		reads,
		buffer,
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(buffer[:n]) != "old-grid" {
		t.Fatalf("first burst=%q, want old-grid", buffer[:n])
	}
	if geometry != oldGeometry {
		t.Fatalf("first geometry=%+v, want %+v", geometry, oldGeometry)
	}
	if pending == nil || string(pending.data) != "new-grid" || pending.geometry != newGeometry {
		t.Fatalf("pending=%+v, want new-grid at %+v", pending, newGeometry)
	}

	n, pending, geometry, err = collectAvailablePTYBurst(*pending, reads, buffer)
	if err != nil || pending != nil || string(buffer[:n]) != "new-grid" || geometry != newGeometry {
		t.Fatalf(
			"second burst=%q pending=%v geometry=%+v error=%v, want new-grid/nil/%+v/nil",
			buffer[:n],
			pending,
			geometry,
			err,
			newGeometry,
		)
	}
}

func TestCollectAvailablePTYBurstCarriesOverflowAndTerminalError(t *testing.T) {
	wantErr := io.EOF
	reads := make(chan ptyReadResult, 1)
	reads <- ptyReadResult{data: bytes.Repeat([]byte("b"), 20*1024), err: wantErr}
	buffer := make([]byte, 32*1024)

	n, pending, _, err := collectAvailablePTYBurst(
		ptyReadResult{data: bytes.Repeat([]byte("a"), 20*1024)},
		reads,
		buffer,
	)
	if err != nil {
		t.Fatalf("first burst error=%v, want nil while data remains", err)
	}
	if n != len(buffer) {
		t.Fatalf("first burst bytes=%d, want %d", n, len(buffer))
	}
	if pending == nil || len(pending.data) != 8*1024 || !errors.Is(pending.err, wantErr) {
		t.Fatalf("pending=%+v, want 8 KiB with EOF", pending)
	}

	n, pending, _, err = collectAvailablePTYBurst(*pending, reads, buffer)
	if n != 8*1024 || pending != nil || !errors.Is(err, wantErr) {
		t.Fatalf("second burst bytes=%d pending=%v error=%v, want 8192/nil/EOF", n, pending, err)
	}
}

type dataAndErrorReader struct {
	data []byte
	err  error
}

func (r *dataAndErrorReader) Read(target []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, r.err
	}
	n := copy(target, r.data)
	r.data = r.data[n:]
	return n, r.err
}

func TestReadPTYPacketsPreservesDataReturnedWithEOF(t *testing.T) {
	reads := make(chan ptyReadResult, 1)
	readPTYPackets(&dataAndErrorReader{data: []byte("last"), err: io.EOF}, reads)

	result, ok := <-reads
	if !ok {
		t.Fatal("PTY result channel closed before the final read")
	}
	if string(result.data) != "last" || !errors.Is(result.err, io.EOF) {
		t.Fatalf("result=%+v, want last/EOF", result)
	}
	if _, ok := <-reads; ok {
		t.Fatal("PTY result channel remained open after EOF")
	}
}

func TestReadPTYPacketsRetriesInterruptedReadWithoutEndingOutput(t *testing.T) {
	reads := make(chan ptyReadResult, 2)
	call := 0
	readPTYPacketsWithPendingGeometry(
		nil,
		reads,
		func() (int, error) { return 0, nil },
		nil,
		func(target []byte) (int, error, TerminalGeometry) {
			call++
			switch call {
			case 1:
				return 0, syscall.EINTR, TerminalGeometry{}
			case 2:
				return copy(target, []byte("after-interrupt")), nil, TerminalGeometry{
					Generation: 7,
					Cols:       102,
					Rows:       27,
				}
			default:
				return 0, io.EOF, TerminalGeometry{}
			}
		},
	)

	first, ok := <-reads
	if !ok {
		t.Fatal("PTY result channel closed after EINTR")
	}
	if first.err != nil || string(first.data) != "after-interrupt" {
		t.Fatalf("first result=%q/%v, want after-interrupt/nil", first.data, first.err)
	}
	if first.geometry != (TerminalGeometry{Generation: 7, Cols: 102, Rows: 27}) {
		t.Fatalf("first geometry=%+v, want post-interrupt read geometry", first.geometry)
	}

	terminal, ok := <-reads
	if !ok || !errors.Is(terminal.err, io.EOF) {
		t.Fatalf("terminal result=%+v open=%v, want EOF", terminal, ok)
	}
	if _, ok := <-reads; ok {
		t.Fatal("PTY result channel remained open after EOF")
	}
}

func TestReadPTYPacketsStopsAfterInterruptedReadWhenProcessIsDone(t *testing.T) {
	reads := make(chan ptyReadResult, 1)
	processDone := make(chan struct{})
	close(processDone)
	calls := 0
	readPTYPacketsWithPendingGeometry(
		nil,
		reads,
		func() (int, error) { return 0, nil },
		processDone,
		func([]byte) (int, error, TerminalGeometry) {
			calls++
			return 0, syscall.EINTR, TerminalGeometry{}
		},
	)

	result, ok := <-reads
	if !ok || !errors.Is(result.err, io.EOF) {
		t.Fatalf("terminal result=%+v open=%v, want EOF after process completion", result, ok)
	}
	if calls != 1 {
		t.Fatalf("read calls=%d, want one interrupted call before the process fence", calls)
	}
}

func TestReadPTYPacketsPreservesDataReturnedWithInterruptedRead(t *testing.T) {
	reads := make(chan ptyReadResult, 3)
	calls := 0
	readPTYPacketsWithPendingGeometry(
		nil,
		reads,
		func() (int, error) { return 0, nil },
		nil,
		func(target []byte) (int, error, TerminalGeometry) {
			calls++
			switch calls {
			case 1:
				return copy(target, []byte("before-interrupt")), syscall.EINTR, TerminalGeometry{
					Generation: 4,
					Cols:       80,
					Rows:       24,
				}
			case 2:
				return copy(target, []byte("after-interrupt")), nil, TerminalGeometry{
					Generation: 4,
					Cols:       80,
					Rows:       24,
				}
			default:
				return 0, io.EOF, TerminalGeometry{}
			}
		},
	)

	first := <-reads
	second := <-reads
	terminal := <-reads
	if string(first.data) != "before-interrupt" || first.err != nil {
		t.Fatalf("first result=%q/%v, want lossless data/nil", first.data, first.err)
	}
	if string(second.data) != "after-interrupt" || second.err != nil {
		t.Fatalf("second result=%q/%v, want continued data/nil", second.data, second.err)
	}
	if !errors.Is(terminal.err, io.EOF) {
		t.Fatalf("terminal error=%v, want EOF", terminal.err)
	}
}
