package livev1

import (
	"context"
	"io"
	"net"
	"runtime"
	"sync"
	"testing"
	"time"
)

type fakeBackend struct {
	mu          sync.Mutex
	attached    Attach
	inputs      []Input
	resizes     []Resize
	subscriber  Subscriber
	detachCount int
}

func testOutputRecord(sequence, timestamp uint64, data []byte) OutputRecord {
	return OutputRecord{
		Sequence:           sequence,
		TimestampMs:        timestamp,
		GeometryGeneration: 1,
		Cols:               80,
		Rows:               24,
		Data:               data,
	}
}

func (b *fakeBackend) Attach(_ context.Context, request Attach, subscriber Subscriber) (Attached, func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.attached = request
	b.subscriber = subscriber
	return Attached{
			HistoryBoundarySequence: 4,
			HistoryGeneration:       2,
			HistoryStartSequence:    3,
			GeometryGeneration:      1,
			Cols:                    80,
			Rows:                    24,
		}, func() {
			b.mu.Lock()
			b.detachCount++
			b.mu.Unlock()
		}, nil
}

func (b *fakeBackend) WriteInput(_ context.Context, _ Attach, input Input) error {
	b.mu.Lock()
	b.inputs = append(b.inputs, input)
	b.mu.Unlock()
	return nil
}

func (b *fakeBackend) Resize(_ context.Context, _ Attach, resize Resize) (EffectiveGeometry, error) {
	b.mu.Lock()
	b.resizes = append(b.resizes, resize)
	b.mu.Unlock()
	return EffectiveGeometry{Generation: 2, OutputSequenceBoundary: 4, Cols: 100, Rows: 30}, nil
}

func (b *fakeBackend) emit(record OutputRecord) bool {
	b.mu.Lock()
	subscriber := b.subscriber
	b.mu.Unlock()
	return subscriber.OnOutput(record)
}

func (b *fakeBackend) emitGeometry(geometry EffectiveGeometry) bool {
	b.mu.Lock()
	subscriber := b.subscriber
	b.mu.Unlock()
	return subscriber.OnGeometry(geometry)
}

func servePipe(t *testing.T, backend Backend) (net.Conn, <-chan error) {
	t.Helper()
	client, server := net.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- NewService(backend).Serve(context.Background(), server)
	}()
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	return client, done
}

func writeBytes(t *testing.T, writer io.Writer, data []byte) {
	t.Helper()
	if _, err := writer.Write(data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestServiceRequiresAttachAndPreservesOrderedInput(t *testing.T) {
	backend := &fakeBackend{}
	client, _ := servePipe(t, backend)
	attachBytes, err := EncodeAttach(Attach{
		AttachGeneration: 1,
		Cols:             80,
		Rows:             24,
		SessionID:        "session",
		ConnectionID:     "connection",
	})
	writeBytes(t, client, mustEncode(t, attachBytes, err))

	attachedFrame := readFrameForTest(t, client)
	attached, err := DecodeAttached(attachedFrame)
	if err != nil {
		t.Fatal(err)
	}
	if attached.HistoryBoundarySequence != 4 || attached.HistoryGeneration != 2 || attached.HistoryStartSequence != 3 ||
		attached.GeometryGeneration != 1 || attached.Cols != 80 || attached.Rows != 24 {
		t.Fatalf("attached = %+v", attached)
	}

	inputOne, inputOneErr := EncodeInput(Input{Sequence: 1, Data: []byte("x")})
	inputTwo, inputTwoErr := EncodeInput(Input{Sequence: 2, Data: []byte("x")})
	resizeBytes, resizeErr := EncodeResize(Resize{Sequence: 1, Cols: 120, Rows: 40})
	writeBytes(t, client, mustEncode(t, inputOne, inputOneErr))
	writeBytes(t, client, mustEncode(t, inputTwo, inputTwoErr))
	writeBytes(t, client, mustEncode(t, resizeBytes, resizeErr))

	resizeApplied, err := DecodeResizeApplied(readFrameForTest(t, client))
	if err != nil || resizeApplied.Sequence != 1 || resizeApplied.GeometryGeneration != 2 || resizeApplied.OutputSequenceBoundary != 4 ||
		resizeApplied.Cols != 100 || resizeApplied.Rows != 30 {
		t.Fatalf("resize applied=%+v err=%v", resizeApplied, err)
	}

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		backend.mu.Lock()
		inputCount := len(backend.inputs)
		backend.mu.Unlock()
		if inputCount == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.inputs) != 2 || string(backend.inputs[0].Data) != "x" || string(backend.inputs[1].Data) != "x" {
		t.Fatalf("inputs = %+v", backend.inputs)
	}
	if len(backend.resizes) != 1 || backend.resizes[0].Sequence != 1 {
		t.Fatalf("resizes = %+v", backend.resizes)
	}
}

func TestServiceBatchesOutputWithoutLosingSequences(t *testing.T) {
	backend := &fakeBackend{}
	client, _ := servePipe(t, backend)
	attachBytes, err := EncodeAttach(Attach{
		AttachGeneration: 1,
		Cols:             80,
		Rows:             24,
		SessionID:        "session",
		ConnectionID:     "connection",
	})
	writeBytes(t, client, mustEncode(t, attachBytes, err))
	_ = readFrameForTest(t, client)

	if !backend.emit(OutputRecord{Sequence: 5, TimestampMs: 10, GeometryGeneration: 1, Cols: 80, Rows: 24, Data: []byte("a")}) {
		t.Fatal("first output rejected")
	}
	if !backend.emit(OutputRecord{Sequence: 6, TimestampMs: 11, GeometryGeneration: 1, Cols: 80, Rows: 24, Data: []byte("b")}) {
		t.Fatal("second output rejected")
	}

	batch, err := DecodeOutputBatch(readFrameForTest(t, client))
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Records) == 1 {
		second, err := DecodeOutputBatch(readFrameForTest(t, client))
		if err != nil {
			t.Fatal(err)
		}
		batch.Records = append(batch.Records, second.Records...)
	}
	if len(batch.Records) != 2 || batch.Records[0].Sequence != 5 || batch.Records[1].Sequence != 6 {
		t.Fatalf("batch = %+v", batch)
	}
	if batch.GeometryGeneration != 1 || batch.Cols != 80 || batch.Rows != 24 {
		t.Fatalf("batch geometry = %+v", batch)
	}
}

func TestServiceSplitsOutputBatchesAtGeometryBoundaries(t *testing.T) {
	backend := &fakeBackend{}
	client, _ := servePipe(t, backend)
	attachBytes, err := EncodeAttach(Attach{
		AttachGeneration: 1,
		Cols:             120,
		Rows:             40,
		SessionID:        "session",
		ConnectionID:     "connection",
	})
	writeBytes(t, client, mustEncode(t, attachBytes, err))
	_ = readFrameForTest(t, client)

	if !backend.emit(OutputRecord{Sequence: 5, TimestampMs: 10, GeometryGeneration: 1, Cols: 120, Rows: 40, Data: []byte("a")}) {
		t.Fatal("first output rejected")
	}
	if !backend.emit(OutputRecord{Sequence: 6, TimestampMs: 11, GeometryGeneration: 2, Cols: 80, Rows: 24, Data: []byte("b")}) {
		t.Fatal("second output rejected")
	}

	first, err := DecodeOutputBatch(readFrameForTest(t, client))
	if err != nil {
		t.Fatal(err)
	}
	second, err := DecodeOutputBatch(readFrameForTest(t, client))
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Records) != 1 || first.Records[0].Sequence != 5 || first.GeometryGeneration != 1 || first.Cols != 120 || first.Rows != 40 {
		t.Fatalf("first batch = %+v", first)
	}
	if len(second.Records) != 1 || second.Records[0].Sequence != 6 || second.GeometryGeneration != 2 || second.Cols != 80 || second.Rows != 24 {
		t.Fatalf("second batch = %+v", second)
	}
}

func TestServicePublishesUnsolicitedGeometryChanges(t *testing.T) {
	backend := &fakeBackend{}
	client, _ := servePipe(t, backend)
	attachBytes, err := EncodeAttach(Attach{
		AttachGeneration: 1,
		Cols:             120,
		Rows:             40,
		SessionID:        "session",
		ConnectionID:     "connection",
	})
	writeBytes(t, client, mustEncode(t, attachBytes, err))
	_ = readFrameForTest(t, client)

	if !backend.emitGeometry(EffectiveGeometry{Generation: 2, OutputSequenceBoundary: 4, Cols: 80, Rows: 24}) {
		t.Fatal("geometry change rejected")
	}
	geometry, err := DecodeGeometryChanged(readFrameForTest(t, client))
	if err != nil {
		t.Fatal(err)
	}
	if geometry.Generation != 2 || geometry.OutputSequenceBoundary != 4 || geometry.Cols != 80 || geometry.Rows != 24 {
		t.Fatalf("geometry = %+v", geometry)
	}
}

func TestServiceStreamClosureUnblocksBackpressuredOutputBeforeWriterStarts(t *testing.T) {
	backend := &fakeBackend{}
	client, done := servePipe(t, backend)
	attachBytes, err := EncodeAttach(Attach{
		AttachGeneration: 1,
		Cols:             80,
		Rows:             24,
		SessionID:        "session",
		ConnectionID:     "connection",
	})
	writeBytes(t, client, mustEncode(t, attachBytes, err))
	deadline := time.Now().Add(time.Second)
	for {
		backend.mu.Lock()
		attached := backend.subscriber.OnOutput != nil
		backend.mu.Unlock()
		if attached {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("backend did not attach subscriber")
		}
		runtime.Gosched()
	}

	for sequence := uint64(1); sequence <= 64; sequence++ {
		if !backend.emit(testOutputRecord(sequence, sequence, make([]byte, 64*1024))) {
			t.Fatalf("failed to fill output queue at sequence %d", sequence)
		}
	}
	result := make(chan bool, 1)
	go func() {
		result <- backend.emit(testOutputRecord(65, 65, make([]byte, 64*1024)))
	}()
	select {
	case accepted := <-result:
		t.Fatalf("full output queue returned before stream closure: accepted=%v", accepted)
	default:
	}

	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case accepted := <-result:
		if accepted {
			t.Fatal("closed stream accepted backpressured output")
		}
	case <-time.After(time.Second):
		t.Fatal("stream closure did not unblock PTY output")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("service did not stop after stream closure")
	}
}

type recordingOutputStream struct {
	mu        sync.Mutex
	decoder   *Decoder
	sequences []uint64
	cancel    context.CancelFunc
}

func (s *recordingOutputStream) Read([]byte) (int, error) { return 0, io.EOF }

func (s *recordingOutputStream) Write(data []byte) (int, error) {
	frames, err := s.decoder.Push(data)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	for _, frame := range frames {
		batch, decodeErr := DecodeOutputBatch(frame)
		if decodeErr != nil {
			s.mu.Unlock()
			return 0, decodeErr
		}
		for _, record := range batch.Records {
			s.sequences = append(s.sequences, record.Sequence)
		}
	}
	if len(s.sequences) == 3 {
		s.cancel()
	}
	s.mu.Unlock()
	return len(data), nil
}

func (s *recordingOutputStream) Close() error { return nil }

type pipelinedOutputStream struct {
	mu        sync.Mutex
	decoder   *Decoder
	started   chan struct{}
	release   chan struct{}
	startOnce sync.Once
	sequences []uint64
	cancel    context.CancelFunc
}

func (s *pipelinedOutputStream) Read([]byte) (int, error) { return 0, io.EOF }

func (s *pipelinedOutputStream) Write(data []byte) (int, error) {
	s.startOnce.Do(func() {
		close(s.started)
		<-s.release
	})
	frames, err := s.decoder.Push(data)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	for _, frame := range frames {
		batch, decodeErr := DecodeOutputBatch(frame)
		if decodeErr != nil {
			s.mu.Unlock()
			return 0, decodeErr
		}
		for _, record := range batch.Records {
			s.sequences = append(s.sequences, record.Sequence)
		}
	}
	if len(s.sequences) == 129 {
		s.cancel()
	}
	s.mu.Unlock()
	return len(data), nil
}

func (s *pipelinedOutputStream) Close() error { return nil }

func TestWriteOutputsPipelinesEncodingWhileStreamWriteIsBlocked(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	queue := newOutputQueue()
	if !queue.enqueue(testOutputRecord(1, 1, make([]byte, 1024))) {
		t.Fatal("first output rejected")
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream := &pipelinedOutputStream{
		decoder: NewDecoder(),
		started: make(chan struct{}),
		release: make(chan struct{}),
		cancel:  cancel,
	}
	done := make(chan error, 1)
	go func() {
		done <- (&Service{}).writeOutputs(
			ctx,
			stream,
			&sync.Mutex{},
			queue,
			make(chan struct{}),
			make(chan struct{}),
		)
	}()

	select {
	case <-stream.started:
	case <-time.After(time.Second):
		t.Fatal("first stream write did not start")
	}
	if !queue.enqueue(testOutputRecord(2, 2, make([]byte, 1024))) {
		t.Fatal("output sequence 2 rejected")
	}
	deadline := time.Now().Add(time.Second)
	for len(queue.items) != 0 && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	if len(queue.items) != 0 {
		t.Fatal("encoder did not take the second output while the first write was blocked")
	}
	for sequence := uint64(3); sequence <= 129; sequence++ {
		if !queue.enqueue(testOutputRecord(sequence, sequence, make([]byte, 1024))) {
			t.Fatalf("output sequence %d rejected", sequence)
		}
	}
	close(stream.release)

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("pipelined output writer did not finish")
	}

	stream.mu.Lock()
	defer stream.mu.Unlock()
	if got, want := stream.sequences, makeSequenceRange(1, 129); !equalSequences(got, want) {
		t.Fatalf("output sequences=%v, want %v", got, want)
	}
}

func TestCollectAvailableOutputFramesCombinesOnlyBufferedFrames(t *testing.T) {
	frames := make(chan encodedOutputFrame, 2)
	frames <- encodedOutputFrame{data: make([]byte, 60*1024), queuedBytes: 60 * 1024}
	frames <- encodedOutputFrame{data: make([]byte, 60*1024), queuedBytes: 60 * 1024}

	output, pending := collectAvailableOutputFrames(
		encodedOutputFrame{data: make([]byte, 1024), queuedBytes: 1024},
		frames,
	)
	if pending != nil {
		t.Fatalf("unexpected pending frame: %+v", pending)
	}
	if got, want := len(output.data), 121*1024; got != want {
		t.Fatalf("combined bytes=%d, want %d", got, want)
	}
	if got, want := output.queuedBytes, 121*1024; got != want {
		t.Fatalf("combined queued bytes=%d, want %d", got, want)
	}

	empty := make(chan encodedOutputFrame)
	output, pending = collectAvailableOutputFrames(
		encodedOutputFrame{data: make([]byte, 1024), queuedBytes: 1024},
		empty,
	)
	if pending != nil || len(output.data) != 1024 {
		t.Fatalf("empty drain output=%d pending=%v, want 1024/nil", len(output.data), pending)
	}
}

func TestCollectAvailableOutputFramesCarriesFramePastWriteLimit(t *testing.T) {
	frames := make(chan encodedOutputFrame, 1)
	frames <- encodedOutputFrame{data: make([]byte, 100*1024), queuedBytes: 100 * 1024}

	output, pending := collectAvailableOutputFrames(
		encodedOutputFrame{data: make([]byte, 200*1024), queuedBytes: 200 * 1024},
		frames,
	)
	if len(output.data) != 200*1024 || output.queuedBytes != 200*1024 {
		t.Fatalf("output=%d/%d, want 204800/204800", len(output.data), output.queuedBytes)
	}
	if pending == nil || len(pending.data) != 100*1024 || pending.queuedBytes != 100*1024 {
		t.Fatalf("pending=%+v, want 102400-byte frame", pending)
	}
}

func TestCollectOutputFramesUntilDeadlineWaitsForWindowExpiry(t *testing.T) {
	frames := make(chan encodedOutputFrame, 1)
	frames <- encodedOutputFrame{data: make([]byte, 1024), queuedBytes: 1024}
	deadline := make(chan time.Time)
	result := make(chan encodedOutputWrite, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		output, _ := collectOutputFramesUntilDeadline(
			ctx,
			encodedOutputFrame{data: make([]byte, 1024), queuedBytes: 1024},
			frames,
			deadline,
		)
		result <- output
	}()

	limit := time.Now().Add(time.Second)
	for len(frames) != 0 && time.Now().Before(limit) {
		runtime.Gosched()
	}
	if len(frames) != 0 {
		t.Fatal("collector did not consume the buffered frame")
	}
	select {
	case <-result:
		t.Fatal("collector returned before the coalescing window expired")
	default:
	}
	deadline <- time.Now()

	select {
	case output := <-result:
		if len(output.data) != 2*1024 || output.queuedBytes != 2*1024 {
			t.Fatalf("output=%d/%d, want 2048/2048", len(output.data), output.queuedBytes)
		}
	case <-time.After(time.Second):
		t.Fatal("collector did not return after coalescing deadline")
	}
}

type fakeOutputTimer struct {
	channel chan time.Time
}

func (t *fakeOutputTimer) Chan() <-chan time.Time { return t.channel }
func (t *fakeOutputTimer) Stop() bool             { return true }

func fillOutputQueue(t *testing.T, queue *outputQueue) {
	t.Helper()
	for sequence := uint64(1); sequence <= 64; sequence++ {
		if !queue.enqueue(testOutputRecord(sequence, sequence, make([]byte, 64*1024))) {
			t.Fatalf("failed to fill output queue at sequence %d", sequence)
		}
	}
}

func TestOutputQueueBlocksAtByteLimitUntilSpaceIsAvailable(t *testing.T) {
	queue := newOutputQueue()
	fillOutputQueue(t, queue)

	result := make(chan bool, 1)
	go func() {
		result <- queue.enqueue(testOutputRecord(65, 65, make([]byte, 64*1024)))
	}()

	assertOutputQueueBytes(t, queue, MaxQueuedOutputBytes)
	select {
	case accepted := <-result:
		t.Fatalf("full output queue returned before space was available: accepted=%v", accepted)
	default:
	}

	queue.takeBytes(64 * 1024)
	select {
	case accepted := <-result:
		if !accepted {
			t.Fatal("output was rejected after space became available")
		}
	case <-time.After(time.Second):
		t.Fatal("output admission did not resume after space became available")
	}
	assertOutputQueueBytes(t, queue, MaxQueuedOutputBytes)
}

func TestOutputQueueCloseUnblocksByteLimitWaiter(t *testing.T) {
	queue := newOutputQueue()
	fillOutputQueue(t, queue)

	result := make(chan bool, 1)
	go func() {
		result <- queue.enqueue(testOutputRecord(65, 65, make([]byte, 64*1024)))
	}()
	assertOutputQueueBytes(t, queue, MaxQueuedOutputBytes)
	queue.close()

	select {
	case accepted := <-result:
		if accepted {
			t.Fatal("closed output queue accepted blocked output")
		}
	case <-time.After(time.Second):
		t.Fatal("closing output queue did not unblock byte-limit waiter")
	}
	assertOutputQueueBytes(t, queue, MaxQueuedOutputBytes)
	if queue.enqueue(testOutputRecord(66, 66, []byte("x"))) {
		t.Fatal("closed output queue accepted new output")
	}
}

func TestOutputQueueCloseReleasesReservationBlockedOnChunkLimit(t *testing.T) {
	queue := newOutputQueue()
	for sequence := uint64(1); sequence <= MaxQueuedOutputChunks; sequence++ {
		if !queue.enqueue(testOutputRecord(sequence, sequence, []byte("x"))) {
			t.Fatalf("failed to fill output chunk queue at sequence %d", sequence)
		}
	}

	result := make(chan bool, 1)
	go func() {
		result <- queue.enqueue(testOutputRecord(MaxQueuedOutputChunks+1, MaxQueuedOutputChunks+1, []byte("x")))
	}()
	assertOutputQueueBytes(t, queue, MaxQueuedOutputChunks+1)
	queue.close()

	select {
	case accepted := <-result:
		if accepted {
			t.Fatal("closed output queue accepted chunk-limit waiter")
		}
	case <-time.After(time.Second):
		t.Fatal("closing output queue did not unblock chunk-limit waiter")
	}
	assertOutputQueueBytes(t, queue, MaxQueuedOutputChunks)
}

func TestOutputQueuePreservesOrderAcrossBackpressure(t *testing.T) {
	queue := newOutputQueue()
	fillOutputQueue(t, queue)

	result := make(chan bool, 1)
	go func() {
		result <- queue.enqueue(testOutputRecord(65, 65, make([]byte, 64*1024)))
	}()
	assertOutputQueueBytes(t, queue, MaxQueuedOutputBytes)

	first := <-queue.items
	queue.takeBytes(len(first.Data))
	if first.Sequence != 1 {
		t.Fatalf("first sequence=%d, want 1", first.Sequence)
	}
	select {
	case accepted := <-result:
		if !accepted {
			t.Fatal("backpressured output was rejected")
		}
	case <-time.After(time.Second):
		t.Fatal("backpressured output did not resume")
	}

	for want := uint64(2); want <= 65; want++ {
		record := <-queue.items
		if record.Sequence != want {
			t.Fatalf("sequence=%d, want %d", record.Sequence, want)
		}
		queue.takeBytes(len(record.Data))
	}
	assertOutputQueueBytes(t, queue, 0)
}

func assertOutputQueueBytes(t *testing.T, queue *outputQueue, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		queue.mu.Lock()
		got := queue.queued
		queue.mu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued bytes=%d, want %d", got, want)
		}
		runtime.Gosched()
	}
}

type scheduledOutputStream struct {
	decoder *Decoder
	writes  chan []uint64
}

func (s *scheduledOutputStream) Read([]byte) (int, error) { return 0, io.EOF }

func (s *scheduledOutputStream) Write(data []byte) (int, error) {
	frames, err := s.decoder.Push(data)
	if err != nil {
		return 0, err
	}
	sequences := make([]uint64, 0)
	for _, frame := range frames {
		batch, decodeErr := DecodeOutputBatch(frame)
		if decodeErr != nil {
			return 0, decodeErr
		}
		for _, record := range batch.Records {
			sequences = append(sequences, record.Sequence)
		}
	}
	s.writes <- sequences
	return len(data), nil
}

func (s *scheduledOutputStream) Close() error { return nil }

func TestWriteOutputsSendsFirstOutputBeforeStartingCoalescingWindow(t *testing.T) {
	createdTimers := make(chan *fakeOutputTimer, 1)
	service := &Service{newOutputTimer: func(window time.Duration) outputTimer {
		if window != time.Millisecond {
			t.Errorf("coalescing window=%s, want 1ms", window)
		}
		timer := &fakeOutputTimer{channel: make(chan time.Time)}
		createdTimers <- timer
		return timer
	}}
	queue := newOutputQueue()
	if !queue.enqueue(testOutputRecord(1, 1, []byte("x"))) {
		t.Fatal("first output rejected")
	}
	ctx, cancel := context.WithCancel(context.Background())
	stream := &scheduledOutputStream{decoder: NewDecoder(), writes: make(chan []uint64, 1)}
	done := make(chan error, 1)
	go func() {
		done <- service.writeOutputs(
			ctx,
			stream,
			&sync.Mutex{},
			queue,
			make(chan struct{}),
			make(chan struct{}),
		)
	}()

	select {
	case sequences := <-stream.writes:
		if !equalSequences(sequences, []uint64{1}) {
			t.Fatalf("first write sequences=%v, want [1]", sequences)
		}
	case <-time.After(time.Second):
		t.Fatal("first output waited for the coalescing window")
	}
	select {
	case <-createdTimers:
	case <-time.After(time.Second):
		t.Fatal("coalescing window was not started after the first write")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("output writer did not stop after cancellation")
	}
}

type byteReader struct {
	data []byte
}

func bytesReader(data []byte) *byteReader { return &byteReader{data: data} }

func (r *byteReader) Read(target []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := copy(target, r.data)
	r.data = r.data[n:]
	return n, nil
}

func TestWriteOutputsPreservesOrderAcrossBatchByteBoundary(t *testing.T) {
	previousProcs := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previousProcs) })

	queue := newOutputQueue()
	for _, record := range []OutputRecord{
		testOutputRecord(1, 1, make([]byte, 40*1024)),
		testOutputRecord(2, 2, make([]byte, 40*1024)),
		testOutputRecord(3, 3, []byte("x")),
	} {
		if !queue.enqueue(record) {
			t.Fatalf("enqueue sequence %d failed", record.Sequence)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	stream := &recordingOutputStream{decoder: NewDecoder(), cancel: cancel}
	err := (&Service{}).writeOutputs(
		ctx,
		stream,
		&sync.Mutex{},
		queue,
		make(chan struct{}),
		make(chan struct{}),
	)
	if err != nil {
		t.Fatal(err)
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if got, want := stream.sequences, []uint64{1, 2, 3}; !equalSequences(got, want) {
		t.Fatalf("output sequences=%v, want %v", got, want)
	}
}

func equalSequences(left, right []uint64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func makeSequenceRange(first, last uint64) []uint64 {
	values := make([]uint64, 0, last-first+1)
	for value := first; value <= last; value++ {
		values = append(values, value)
	}
	return values
}

func TestServiceRejectsInputBeforeAttach(t *testing.T) {
	backend := &fakeBackend{}
	client, done := servePipe(t, backend)
	inputBytes, err := EncodeInput(Input{Sequence: 1, Data: []byte("x")})
	writeBytes(t, client, mustEncode(t, inputBytes, err))
	frame := readFrameForTest(t, client)
	if frame.Type != FrameError {
		t.Fatalf("frame type=%x, want error", frame.Type)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("protocol violation returned nil")
		}
	case <-time.After(time.Second):
		t.Fatal("service did not close after protocol violation")
	}
}

func mustEncode(t *testing.T, data []byte, err error) []byte {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func readFrameForTest(t *testing.T, reader io.Reader) Frame {
	t.Helper()
	_ = reader
	frame, err := ReadFrame(reader)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return frame
}
