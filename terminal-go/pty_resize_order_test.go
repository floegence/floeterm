package terminal

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

type replenishedPendingMonitor struct {
	mu               sync.Mutex
	oldGeometryPolls int
	bytesRead        int
	released         bool
	generation       func() uint64
}

type ioctlWindowPendingMonitor struct {
	mu      sync.Mutex
	pending int
}

func (m *ioctlWindowPendingMonitor) PendingBytes() (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.pending, nil
}

func (m *ioctlWindowPendingMonitor) Close() error { return nil }

func (m *ioctlWindowPendingMonitor) noteRead(size int) {
	m.mu.Lock()
	m.pending -= size
	if m.pending < 0 {
		m.pending = 0
	}
	m.mu.Unlock()
}

func (m *ioctlWindowPendingMonitor) addPending(size int) {
	m.mu.Lock()
	m.pending += size
	m.mu.Unlock()
}

func TestPTYReaderAdmitsReadableTailWhenPendingSnapshotIsZero(t *testing.T) {
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	readerWake, resizeWake, err := os.Pipe()
	if err != nil {
		_ = outputReader.Close()
		_ = outputWriter.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = outputReader.Close()
		_ = outputWriter.Close()
		_ = readerWake.Close()
		_ = resizeWake.Close()
	})

	completionTail := []byte("\x1b]633;D;0\a\x1b]633;P;Cwd=/workspace\a\x1b]633;A\a")
	if _, err := outputWriter.Write(completionTail); err != nil {
		t.Fatal(err)
	}

	session := newOutputActivityTestSession(&outputActivityCaptureHandler{}, time.Hour)
	session.lastAppliedCols = 80
	session.lastAppliedRows = 24
	session.geometryGeneration = 1
	session.foregroundCommand = TerminalForegroundCommandInfo{
		Phase:       ForegroundCommandRunning,
		DisplayName: "sleep",
		Revision:    1,
	}
	session.outputActivity = TerminalOutputActivityInfo{
		Phase:    OutputActivitySettled,
		Revision: 1,
	}
	processDone := make(chan struct{})
	readResult := make(chan ptyReadResult, 1)
	readPacket := session.readPTYPacketFunc(
		int(outputReader.Fd()),
		int(readerWake.Fd()),
		&ioctlWindowPendingMonitor{},
		processDone,
	)
	go func() {
		buffer := make([]byte, 256)
		n, readErr, geometry := readPacket(buffer)
		readResult <- ptyReadResult{
			data:     append([]byte(nil), buffer[:n]...),
			err:      readErr,
			geometry: geometry,
		}
	}()

	select {
	case result := <-readResult:
		if result.err != nil {
			t.Fatalf("read completion tail: %v", result.err)
		}
		if !bytes.Equal(result.data, completionTail) {
			t.Fatalf("completion tail = %q, want %q", result.data, completionTail)
		}
		if result.geometry.Generation != 1 {
			t.Fatalf("completion tail geometry = %+v, want generation 1", result.geometry)
		}
		session.processAdmittedPTYDataAtGeometry(result.data, result.geometry)
		info := session.ToSessionInfo()
		if info.ForegroundCommand.Phase != ForegroundCommandIdle || info.OutputActivity.Phase != OutputActivityUnknown {
			t.Fatalf("completion tail metadata = foreground %+v output %+v, want idle/unknown", info.ForegroundCommand, info.OutputActivity)
		}
		history, historyErr := session.GetHistoryChunks()
		if historyErr != nil {
			t.Fatal(historyErr)
		}
		if len(history) != 1 || history[0].Sequence != 1 ||
			!bytes.Equal(history[0].Data, completionTail) {
			t.Fatalf("completion tail history = %+v, want one lossless sequence", history)
		}
	case <-time.After(100 * time.Millisecond):
		close(processDone)
		select {
		case <-readResult:
		case <-time.After(time.Second):
			t.Fatal("PTY reader did not stop after the process fence")
		}
		t.Fatal("readable completion tail was not admitted while pending snapshot remained zero")
	}
}

func (m *replenishedPendingMonitor) PendingBytes() (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.released {
		return 0, nil
	}
	if m.generation() > 1 {
		return max(0, 8-m.bytesRead), nil
	}
	m.oldGeometryPolls++
	return 1, nil
}

func (m *replenishedPendingMonitor) Close() error { return nil }

func (m *replenishedPendingMonitor) noteRead(size int) {
	m.mu.Lock()
	m.bytesRead += size
	m.mu.Unlock()
}

func (m *replenishedPendingMonitor) snapshot() (polls, bytesRead int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.oldGeometryPolls, m.bytesRead
}

func (m *replenishedPendingMonitor) readCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bytesRead
}

func (m *replenishedPendingMonitor) release() {
	m.mu.Lock()
	m.released = true
	m.mu.Unlock()
}

func TestPTYResizeDrainCannotBeStarvedByReplenishedOutput(t *testing.T) {
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = outputReader.Close()
		_ = outputWriter.Close()
	})
	readerWake, resizeWake, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = readerWake.Close()
		_ = resizeWake.Close()
	})
	go func() {
		for {
			if _, err := outputWriter.Write([]byte("x")); err != nil {
				return
			}
		}
	}()

	events := make(chan TerminalOutputEvent, 8)
	session := &Session{
		ID:                   "replenished-output-resize",
		PTY:                  &os.File{},
		isActive:             true,
		connections:          map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		ringBuffer:           NewTerminalRingBuffer(1024),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      80,
		lastAppliedRows:      24,
		geometryGeneration:   1,
		setPTYSize:           func(*os.File, *pty.Winsize) error { return nil },
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
	session.ptyReaderReady = true
	session.ptyReaderWakeFD = int(resizeWake.Fd())
	monitor := &replenishedPendingMonitor{generation: func() uint64 {
		session.mu.RLock()
		defer session.mu.RUnlock()
		return session.geometryGeneration
	}}
	t.Cleanup(func() {
		monitor.release()
		_ = outputReader.Close()
		_ = outputWriter.Close()
	})
	readPacket := session.readPTYPacketFunc(
		int(outputReader.Fd()),
		int(readerWake.Fd()),
		monitor,
		nil,
	)
	firstBuffer := make([]byte, 1)
	firstSize, firstErr, firstGeometry := readPacket(firstBuffer)
	if firstErr != nil || firstSize != 1 {
		t.Fatalf("admit initial old output: size=%d error=%v", firstSize, firstErr)
	}
	monitor.noteRead(firstSize)
	session.processAdmittedPTYDataAtGeometry(firstBuffer[:firstSize], firstGeometry)
	first := <-events
	if first.Sequence != 1 || first.Geometry.Generation != 1 {
		t.Fatalf("initial admitted output=%+v, want old generation sequence 1", first)
	}

	resizeResult := make(chan struct {
		geometry TerminalGeometry
		err      error
	}, 1)
	go func() {
		geometry, resizeErr := session.ApplyConnectionSize("view", 120, 40)
		resizeResult <- struct {
			geometry TerminalGeometry
			err      error
		}{geometry: geometry, err: resizeErr}
	}()
	for {
		session.ptyOrderMu.Lock()
		draining := session.ptyResizeDrain
		session.ptyOrderMu.Unlock()
		if draining {
			break
		}
		runtime.Gosched()
	}

	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for monitor.readCount() < 8 {
			buffer := make([]byte, 8)
			n, readErr, geometry := readPacket(buffer)
			if readErr != nil || n <= 0 {
				return
			}
			monitor.noteRead(n)
			session.processAdmittedPTYDataAtGeometry(buffer[:n], geometry)
		}
	}()

	var result struct {
		geometry TerminalGeometry
		err      error
	}
	select {
	case result = <-resizeResult:
	case <-time.After(time.Second):
		polls, bytesRead := monitor.snapshot()
		monitor.release()
		_ = outputReader.Close()
		_ = outputWriter.Close()
		t.Fatalf("resize ownership starved after 1s: pending polls=%d bytes read=%d", polls, bytesRead)
	}
	if result.err != nil {
		t.Fatalf("resize with replenished output: %v", result.err)
	}
	if result.geometry.Generation != 2 || result.geometry.OutputSequenceBoundary != 1 {
		t.Fatalf("resize ACK=%+v, want generation 2 covering only admitted sequence 1", result.geometry)
	}
	select {
	case <-readerDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish after resize ownership transfer")
	}
	if err := readerWake.SetReadDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	var wakeByte [1]byte
	if n, err := readerWake.Read(wakeByte[:]); n != 0 || err == nil {
		t.Fatalf("resize wake pipe retained a handoff byte: size=%d error=%v", n, err)
	}
	close(events)
	var received []TerminalOutputEvent
	for event := range events {
		received = append(received, event)
	}
	polls, bytesRead := monitor.snapshot()
	if len(received) == 0 {
		t.Fatal("no ordered PTY output was committed")
	}
	if bytesRead < 1 || polls < 1 {
		t.Fatalf("replenished output was not observed: pending polls=%d bytes read=%d", polls, bytesRead)
	}
	for _, event := range received {
		if event.Sequence <= result.geometry.OutputSequenceBoundary || event.Geometry.Generation != 2 {
			t.Fatalf("post-barrier replenished output=%+v, ACK=%+v", event, result.geometry)
		}
	}
}

func TestPTYResizeOrdersUnadmittedKernelOutputAfterIoctl(t *testing.T) {
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = outputReader.Close()
		_ = outputWriter.Close()
	})
	readerWake, resizeWake, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = readerWake.Close()
		_ = resizeWake.Close()
	})
	if _, err := outputWriter.Write([]byte("A")); err != nil {
		t.Fatal(err)
	}

	ioctlStarted := make(chan struct{})
	allowIoctl := make(chan struct{})
	ioctlApplied := make(chan struct{})
	events := make(chan TerminalOutputEvent, 2)
	monitor := &ioctlWindowPendingMonitor{pending: 1}
	session := &Session{
		ID:                   "snapshot-ioctl-window",
		PTY:                  &os.File{},
		isActive:             true,
		connections:          map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		ringBuffer:           NewTerminalRingBuffer(1024),
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      80,
		lastAppliedRows:      24,
		geometryGeneration:   1,
		setPTYSize: func(*os.File, *pty.Winsize) error {
			close(ioctlStarted)
			<-allowIoctl
			close(ioctlApplied)
			return nil
		},
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
	session.ptyReaderReady = true
	session.ptyReaderWakeFD = int(resizeWake.Fd())
	readPacket := session.readPTYPacketFunc(
		int(outputReader.Fd()),
		int(readerWake.Fd()),
		monitor,
		nil,
	)
	firstBuffer := make([]byte, 1)
	firstSize, firstErr, firstGeometry := readPacket(firstBuffer)
	if firstErr != nil || firstSize != 1 {
		t.Fatalf("admit output before resize: size=%d error=%v", firstSize, firstErr)
	}
	monitor.noteRead(firstSize)
	session.processAdmittedPTYDataAtGeometry(firstBuffer[:firstSize], firstGeometry)
	first := <-events
	if string(first.Data) != "A" || first.Sequence != 1 || first.Geometry.Generation != 1 {
		t.Fatalf("pre-resize admitted output=%+v, want sequence 1 at old generation", first)
	}

	resizeResult := make(chan struct {
		geometry TerminalGeometry
		err      error
	}, 1)
	go func() {
		geometry, resizeErr := session.ApplyConnectionSize("view", 120, 40)
		resizeResult <- struct {
			geometry TerminalGeometry
			err      error
		}{geometry: geometry, err: resizeErr}
	}()

	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		buffer := make([]byte, 1)
		n, readErr, geometry := readPacket(buffer)
		if readErr != nil || n != 1 {
			return
		}
		monitor.noteRead(n)
		session.processAdmittedPTYDataAtGeometry(buffer[:n], geometry)
	}()

	select {
	case <-ioctlStarted:
	case <-time.After(time.Second):
		t.Fatal("resize did not reach the PTY ioctl boundary after quota commit")
	}
	select {
	case <-ioctlApplied:
		t.Fatal("PTY ioctl completed before the controlled window output was injected")
	default:
	}
	if _, err := outputWriter.Write([]byte("B")); err != nil {
		t.Fatal(err)
	}
	monitor.addPending(1)
	close(allowIoctl)

	result := <-resizeResult
	if result.err != nil {
		t.Fatalf("resize after controlled ioctl window: %v", result.err)
	}
	second := <-events
	select {
	case <-readerDone:
	case <-time.After(time.Second):
		t.Fatal("reader did not finish controlled ioctl window output")
	}
	if string(second.Data) != "B" || second.Sequence != 2 {
		t.Fatalf("ioctl-window output=%+v, want sequence 2", second)
	}
	if second.Geometry.Generation != 2 || result.geometry.OutputSequenceBoundary != 1 {
		t.Fatalf(
			"unadmitted kernel output was not ordered after resize: output geometry=%+v resize ACK=%+v; want generation 2 and ACK boundary 1",
			second.Geometry,
			result.geometry,
		)
	}
}

func TestPTYResizeWaitsForDurableOldGeometryCommit(t *testing.T) {
	oldGeometry := TerminalGeometry{Generation: 4, Cols: 195, Rows: 60}
	spool := openTestHistorySpool(t, t.TempDir())
	t.Cleanup(func() { _ = spool.Close() })
	appendStarted := make(chan struct{})
	allowAppend := make(chan struct{})
	events := make(chan TerminalOutputEvent, 2)
	session := &Session{
		ID:                   "durable-resize-order",
		PTY:                  &os.File{},
		isActive:             true,
		connections:          map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: oldGeometry.Cols, Rows: oldGeometry.Rows}},
		ringBuffer:           NewTerminalRingBuffer(1024),
		historySpool:         spool,
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      oldGeometry.Cols,
		lastAppliedRows:      oldGeometry.Rows,
		geometryGeneration:   oldGeometry.Generation,
		setPTYSize:           func(*os.File, *pty.Winsize) error { return nil },
		liveAttachments:      make(map[string]liveAttachment),
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		appendHistorySpool: func(spool *TerminalHistorySpool, chunk TerminalDataChunk) error {
			if chunk.Sequence == 1 {
				close(appendStarted)
				<-allowAppend
			}
			return spool.Append(chunk)
		},
	}
	session.liveAttachments["view"] = liveAttachment{
		generation: 1,
		subscriber: LiveSubscriber{OnOutput: func(event TerminalOutputEvent) bool {
			events <- event
			return true
		}},
	}

	oldBytes := []byte("old-grid-frame")
	n, err, captured := session.readPTYPacketOrdered(make([]byte, 64), func(target []byte) (int, error) {
		return copy(target, oldBytes), nil
	}, nil)
	if err != nil || n != len(oldBytes) || captured != oldGeometry {
		t.Fatalf("old packet read=%d/%v geometry=%+v", n, err, captured)
	}
	commitDone := make(chan struct{})
	go func() {
		session.processAdmittedPTYDataAtGeometry(oldBytes, captured)
		close(commitDone)
	}()
	select {
	case <-appendStarted:
	case <-time.After(time.Second):
		t.Fatal("durable append did not reach the barrier")
	}

	resizeReturned := make(chan struct {
		geometry TerminalGeometry
		err      error
	}, 1)
	go func() {
		geometry, resizeErr := session.ApplyConnectionSize("view", 120, 40)
		resizeReturned <- struct {
			geometry TerminalGeometry
			err      error
		}{geometry: geometry, err: resizeErr}
	}()
	select {
	case result := <-resizeReturned:
		t.Fatalf("resize returned before durable old output commit: %+v", result)
	default:
	}
	close(allowAppend)
	select {
	case <-commitDone:
	case <-time.After(time.Second):
		t.Fatal("old output commit did not complete")
	}
	result := <-resizeReturned
	if result.err != nil {
		t.Fatalf("resize failed after durable commit: %v", result.err)
	}
	if result.geometry.OutputSequenceBoundary != 1 || result.geometry.Generation != 5 || result.geometry.Cols != 120 || result.geometry.Rows != 40 {
		t.Fatalf("resize geometry=%+v, want generation 5 boundary 1 at 120x40", result.geometry)
	}

	newBytes := []byte("new-grid-frame")
	buffer := make([]byte, 64)
	n, err, newGeometry := session.readPTYPacketOrdered(buffer, func(target []byte) (int, error) {
		return copy(target, newBytes), nil
	}, nil)
	if err != nil || n != len(newBytes) || newGeometry.Generation != 5 || newGeometry.Cols != 120 || newGeometry.Rows != 40 {
		t.Fatalf("new packet read=%d/%v geometry=%+v", n, err, newGeometry)
	}
	session.processAdmittedPTYDataAtGeometry(buffer[:n], newGeometry)

	first, second := <-events, <-events
	received := append(append([]byte(nil), first.Data...), second.Data...)
	if sha256.Sum256(received) != sha256.Sum256(append(oldBytes, newBytes...)) {
		t.Fatalf("output bytes changed: got=%q", received)
	}
	if first.Sequence != 1 || first.Geometry != oldGeometry || second.Sequence != 2 || second.Geometry != newGeometry {
		t.Fatalf("ordered events first=%+v second=%+v", first, second)
	}
	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: 2})
	if err != nil || len(page.Chunks) != 2 || page.CoveredThroughSequence != 2 {
		t.Fatalf("durable history page=%+v error=%v", page, err)
	}
}

func TestIdlePTYReadinessWaitDoesNotBlockResize(t *testing.T) {
	waitStarted := make(chan struct{})
	allowWait := make(chan struct{})
	readReturned := make(chan error, 1)
	session := &Session{
		ID:                 "idle-read-resize",
		PTY:                &os.File{},
		isActive:           true,
		connections:        map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		lastAppliedCols:    80,
		lastAppliedRows:    24,
		geometryGeneration: 1,
		setPTYSize:         func(*os.File, *pty.Winsize) error { return nil },
		config:             newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	go func() {
		_, err, _ := session.readPTYPacketOrdered(make([]byte, 16), func([]byte) (int, error) {
			return 0, syscall.EAGAIN
		}, func() error {
			close(waitStarted)
			<-allowWait
			return io.EOF
		})
		readReturned <- err
	}()
	select {
	case <-waitStarted:
	case <-time.After(time.Second):
		t.Fatal("idle reader did not wait for readiness")
	}
	geometry, err := session.ApplyConnectionSize("view", 120, 40)
	if err != nil || geometry.Cols != 120 || geometry.Rows != 40 {
		t.Fatalf("idle resize geometry=%+v error=%v", geometry, err)
	}
	close(allowWait)
	select {
	case err := <-readReturned:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("idle read error=%v, want EOF", err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle reader did not stop")
	}
}

func TestPTYResizeFailsClosedAfterOrderedHistoryCommitFailure(t *testing.T) {
	spool := openTestHistorySpool(t, t.TempDir())
	t.Cleanup(func() { _ = spool.Close() })
	session := &Session{
		ID:                   "failed-order-resize",
		PTY:                  &os.File{},
		isActive:             true,
		connections:          map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		ringBuffer:           NewTerminalRingBuffer(16),
		historySpool:         spool,
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      80,
		lastAppliedRows:      24,
		geometryGeneration:   1,
		setPTYSize:           func(*os.File, *pty.Winsize) error { return nil },
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		appendHistorySpool: func(*TerminalHistorySpool, TerminalDataChunk) error {
			return errors.New("durable append failed")
		},
	}
	data := []byte("uncommitted")
	_, _, geometry := session.readPTYPacketOrdered(make([]byte, 32), func(target []byte) (int, error) {
		return copy(target, data), nil
	}, nil)
	session.processAdmittedPTYDataAtGeometry(data, geometry)
	if _, err := session.ApplyConnectionSize("view", 120, 40); err == nil || !bytes.Contains([]byte(err.Error()), []byte("output ordering failed")) {
		t.Fatalf("resize error=%v, want output ordering failure", err)
	}
}

func TestPTYResizeFailsClosedAfterDuplicateReadCompletion(t *testing.T) {
	resizeCalls := 0
	session := &Session{
		ID:                 "duplicate-read-completion",
		PTY:                &os.File{},
		isActive:           true,
		connections:        map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		lastAppliedCols:    80,
		lastAppliedRows:    24,
		geometryGeneration: 1,
		ptyReadBytes:       1,
		setPTYSize: func(*os.File, *pty.Winsize) error {
			resizeCalls++
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	session.completePTYRead(1, nil)
	session.completePTYRead(1, nil)

	if _, err := session.ApplyConnectionSize("view", 120, 40); err == nil || !bytes.Contains([]byte(err.Error()), []byte("output ordering failed")) {
		t.Fatalf("resize error=%v, want duplicate completion to fail closed", err)
	}
	if resizeCalls != 0 {
		t.Fatalf("PTY resize calls=%d, want 0 after duplicate completion", resizeCalls)
	}
}

func TestSessionCleanupWakesIdlePTYReader(t *testing.T) {
	outputReader, outputWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = outputReader.Close()
		_ = outputWriter.Close()
	})
	readerWake, cleanupWake, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = readerWake.Close()
		_ = cleanupWake.Close()
	})

	session := &Session{
		ID:              "cleanup-idle-reader",
		connections:     make(map[string]*ConnectionInfo),
		liveAttachments: make(map[string]liveAttachment),
		ptyReaderReady:  true,
		ptyReaderWakeFD: int(cleanupWake.Fd()),
		config:          newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	monitor := &ioctlWindowPendingMonitor{}
	readPacket := session.readPTYPacketFunc(
		int(outputReader.Fd()),
		int(readerWake.Fd()),
		monitor,
		nil,
	)
	readReturned := make(chan error, 1)
	go func() {
		_, readErr, _ := readPacket(make([]byte, 1))
		readReturned <- readErr
	}()

	cleanupReturned := make(chan struct{})
	go func() {
		session.cleanup()
		close(cleanupReturned)
	}()

	select {
	case err := <-readReturned:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("idle reader error=%v, want EOF after cleanup", err)
		}
	case <-time.After(time.Second):
		t.Fatal("session cleanup did not wake the idle PTY reader")
	}
	select {
	case <-cleanupReturned:
	case <-time.After(time.Second):
		t.Fatal("session cleanup did not return")
	}
}

func TestSessionCleanupReleasesResizeWaitingForAdmittedOutput(t *testing.T) {
	session := &Session{
		ID:                 "cleanup-active-resize",
		isActive:           true,
		connections:        map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		liveAttachments:    make(map[string]liveAttachment),
		lastAppliedCols:    80,
		lastAppliedRows:    24,
		geometryGeneration: 1,
		ptyReadBytes:       1,
		config:             newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	resizeReturned := make(chan error, 1)
	go func() {
		_, resizeErr := session.ApplyConnectionSize("view", 120, 40)
		resizeReturned <- resizeErr
	}()

	deadline := time.Now().Add(time.Second)
	for {
		session.ptyOrderMu.Lock()
		active := session.ptyResizeActive
		session.ptyOrderMu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("resize did not wait for admitted output")
		}
		runtime.Gosched()
	}

	cleanupReturned := make(chan struct{})
	go func() {
		session.cleanup()
		close(cleanupReturned)
	}()
	select {
	case err := <-resizeReturned:
		if !errors.Is(err, errSessionClosed) {
			t.Fatalf("resize error=%v, want session closed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cleanup did not release resize waiting for admitted output")
	}
	select {
	case <-cleanupReturned:
		t.Fatal("cleanup returned before admitted output completed")
	default:
	}
	session.completePTYRead(1, nil)
	select {
	case <-cleanupReturned:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not return after admitted output completed")
	}
}

func TestSessionCleanupOrdersBeforeBlockedDurableCommitAndResizeACK(t *testing.T) {
	spool := openTestHistorySpool(t, t.TempDir())
	t.Cleanup(func() { _ = spool.Close() })
	appendStarted := make(chan struct{})
	allowAppend := make(chan struct{})
	resizeCalls := 0
	session := &Session{
		ID:                   "cleanup-durable-resize",
		PTY:                  &os.File{},
		isActive:             true,
		connections:          map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(16),
		historySpool:         spool,
		historyGeneration:    1,
		historyStartSequence: 1,
		lastAppliedCols:      80,
		lastAppliedRows:      24,
		geometryGeneration:   1,
		setPTYSize: func(*os.File, *pty.Winsize) error {
			resizeCalls++
			return nil
		},
		appendHistorySpool: func(spool *TerminalHistorySpool, chunk TerminalDataChunk) error {
			close(appendStarted)
			<-allowAppend
			return spool.Append(chunk)
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	data := []byte("admitted-before-close")
	_, _, geometry := session.readPTYPacketOrdered(make([]byte, len(data)), func(target []byte) (int, error) {
		return copy(target, data), nil
	}, nil)
	commitReturned := make(chan struct{})
	go func() {
		session.processAdmittedPTYDataAtGeometry(data, geometry)
		close(commitReturned)
	}()
	select {
	case <-appendStarted:
	case <-time.After(time.Second):
		t.Fatal("durable commit did not reach the barrier")
	}

	resizeReturned := make(chan error, 1)
	go func() {
		_, resizeErr := session.ApplyConnectionSize("view", 120, 40)
		resizeReturned <- resizeErr
	}()
	cleanupReturned := make(chan struct{})
	go func() {
		session.cleanup()
		close(cleanupReturned)
	}()

	deadline := time.Now().Add(time.Second)
	for {
		session.ptyOrderMu.Lock()
		closed := session.ptyOrderClosed
		session.ptyOrderMu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cleanup did not enter the PTY order domain while durable commit was blocked")
		}
		runtime.Gosched()
	}
	select {
	case err := <-resizeReturned:
		if !errors.Is(err, errSessionClosed) {
			t.Fatalf("resize error=%v, want session closed", err)
		}
	case <-time.After(time.Second):
		t.Fatal("resize did not fail after ordered cleanup")
	}
	if resizeCalls != 0 {
		t.Fatalf("PTY resize calls=%d, want no ioctl or ACK after ordered cleanup", resizeCalls)
	}
	select {
	case <-cleanupReturned:
		t.Fatal("cleanup returned before the admitted durable commit completed")
	default:
	}

	close(allowAppend)
	select {
	case <-commitReturned:
	case <-time.After(time.Second):
		t.Fatal("admitted durable commit did not complete after release")
	}
	select {
	case <-cleanupReturned:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not finish after admitted durable commit")
	}
}
