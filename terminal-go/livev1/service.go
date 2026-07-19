package livev1

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const (
	MaxQueuedOutputBytes  = 4 * 1024 * 1024
	MaxQueuedOutputChunks = 4096
	maxOutputStreamBytes  = 256 * 1024
	OutputCoalesceWindow  = time.Millisecond

	ErrorCodeProtocolViolation uint16 = 1
	ErrorCodePermissionDenied  uint16 = 2
	ErrorCodeSessionNotFound   uint16 = 3
	ErrorCodeActivationFailed  uint16 = 4
	ErrorCodeSlowConsumer      uint16 = 5
	ErrorCodeInternal          uint16 = 6
)

var (
	ErrProtocolViolation = errors.New("terminal live protocol violation")
	ErrPermissionDenied  = errors.New("terminal live permission denied")
	ErrSessionNotFound   = errors.New("terminal live session not found")
	ErrActivationFailed  = errors.New("terminal live activation failed")
	ErrSlowConsumer      = errors.New("terminal live slow consumer")
)

type Subscriber struct {
	OnOutput        func(OutputRecord) bool
	OnGeometry      func(EffectiveGeometry) bool
	OnSessionClosed func()
	OnSuperseded    func()
}

type Backend interface {
	Attach(ctx context.Context, request Attach, subscriber Subscriber) (Attached, func(), error)
	WriteInput(ctx context.Context, attachment Attach, input Input) error
	Resize(ctx context.Context, attachment Attach, resize Resize) (EffectiveGeometry, error)
}

type Service struct {
	backend        Backend
	newOutputTimer func(time.Duration) outputTimer
}

func NewService(backend Backend) *Service {
	return &Service{backend: backend}
}

type outputQueue struct {
	mu        sync.Mutex
	queued    int
	items     chan OutputRecord
	space     chan struct{}
	closed    chan struct{}
	isClosed  bool
	closeOnce sync.Once
}

func newOutputQueue() *outputQueue {
	return &outputQueue{
		items:  make(chan OutputRecord, MaxQueuedOutputChunks),
		space:  make(chan struct{}),
		closed: make(chan struct{}),
	}
}

func (q *outputQueue) enqueue(record OutputRecord) bool {
	if q == nil || record.GeometryGeneration == 0 || record.Cols == 0 || record.Rows == 0 ||
		len(record.Data) == 0 || len(record.Data) > MaxQueuedOutputBytes {
		return false
	}
	owned := OutputRecord{
		Sequence:           record.Sequence,
		TimestampMs:        record.TimestampMs,
		GeometryGeneration: record.GeometryGeneration,
		Cols:               record.Cols,
		Rows:               record.Rows,
		Data:               append([]byte(nil), record.Data...),
	}
	for {
		q.mu.Lock()
		if q.isClosed {
			q.mu.Unlock()
			return false
		}
		if q.queued+len(owned.Data) <= MaxQueuedOutputBytes {
			q.queued += len(owned.Data)
			q.mu.Unlock()
			select {
			case q.items <- owned:
				return true
			case <-q.closed:
				q.takeBytes(len(owned.Data))
				return false
			}
		}
		space := q.space
		q.mu.Unlock()

		select {
		case <-space:
			continue
		case <-q.closed:
			return false
		}
	}
}

func (q *outputQueue) close() {
	if q == nil {
		return
	}
	q.closeOnce.Do(func() {
		q.mu.Lock()
		q.isClosed = true
		q.mu.Unlock()
		close(q.closed)
	})
}

func (q *outputQueue) takeBytes(size int) {
	q.mu.Lock()
	q.queued -= size
	if q.queued < 0 {
		q.queued = 0
	}
	close(q.space)
	q.space = make(chan struct{})
	q.mu.Unlock()
}

func (s *Service) Serve(parent context.Context, stream io.ReadWriteCloser) error {
	if s == nil || s.backend == nil {
		return errors.New("terminal live backend is required")
	}
	if stream == nil {
		return errors.New("terminal live stream is required")
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer stream.Close()

	first, err := ReadFrame(stream)
	if err != nil {
		return err
	}
	if first.Type != FrameAttach {
		return s.protocolFailure(stream, ErrorCodeProtocolViolation, "attach frame required", ErrProtocolViolation)
	}
	attachment, err := DecodeAttach(first)
	if err != nil {
		return s.protocolFailure(stream, ErrorCodeProtocolViolation, "invalid attach frame", err)
	}

	queue := newOutputQueue()
	defer queue.close()
	sessionClosed := make(chan struct{})
	superseded := make(chan struct{})
	var sessionClosedOnce sync.Once
	var supersededOnce sync.Once
	var writeMu sync.Mutex
	writeBytes := func(data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeAll(stream, data)
	}
	var geometryMu sync.Mutex
	attachedWritten := false
	var pendingGeometry *EffectiveGeometry
	writeGeometry := func(geometry EffectiveGeometry) bool {
		geometryMu.Lock()
		if !attachedWritten {
			copyGeometry := geometry
			pendingGeometry = &copyGeometry
			geometryMu.Unlock()
			return true
		}
		geometryMu.Unlock()
		encoded, encodeErr := EncodeGeometryChanged(geometry)
		if encodeErr != nil || writeBytes(encoded) != nil {
			cancel()
			_ = stream.Close()
			return false
		}
		return true
	}
	attached, detach, err := s.backend.Attach(ctx, attachment, Subscriber{
		OnOutput:   queue.enqueue,
		OnGeometry: writeGeometry,
		OnSessionClosed: func() {
			sessionClosedOnce.Do(func() { close(sessionClosed) })
		},
		OnSuperseded: func() {
			supersededOnce.Do(func() { close(superseded) })
		},
	})
	if err != nil {
		code := ErrorCodeInternal
		message := "terminal attach failed"
		switch {
		case errors.Is(err, ErrPermissionDenied):
			code, message = ErrorCodePermissionDenied, "terminal permission denied"
		case errors.Is(err, ErrSessionNotFound):
			code, message = ErrorCodeSessionNotFound, "terminal session not found"
		case errors.Is(err, ErrActivationFailed):
			code, message = ErrorCodeActivationFailed, "terminal activation failed"
		}
		return s.protocolFailure(stream, code, message, err)
	}
	if detach == nil {
		detach = func() {}
	}
	defer detach()

	attachedBytes, err := EncodeAttached(attached)
	if err != nil {
		return err
	}
	if err := writeBytes(attachedBytes); err != nil {
		return err
	}
	geometryMu.Lock()
	attachedWritten = true
	pending := pendingGeometry
	pendingGeometry = nil
	geometryMu.Unlock()
	if pending != nil && pending.Generation > attached.GeometryGeneration {
		if !writeGeometry(*pending) {
			return io.ErrClosedPipe
		}
	}

	writerDone := make(chan error, 1)
	go func() {
		writerDone <- s.writeOutputs(ctx, stream, &writeMu, queue, sessionClosed, superseded)
	}()

	var lastInputSequence uint64
	var lastResizeSequence uint64
	for {
		frame, readErr := ReadFrame(stream)
		if readErr != nil {
			select {
			case writerErr := <-writerDone:
				if writerErr != nil {
					return writerErr
				}
			default:
			}
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrClosedPipe) || errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return readErr
		}
		switch frame.Type {
		case FrameInput:
			input, decodeErr := DecodeInput(frame)
			if decodeErr != nil || input.Sequence <= lastInputSequence {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "invalid input sequence", ErrProtocolViolation)
			}
			if err := s.backend.WriteInput(ctx, attachment, input); err != nil {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeInternal, "terminal input failed", err)
			}
			lastInputSequence = input.Sequence
		case FrameResize:
			resize, decodeErr := DecodeResize(frame)
			if decodeErr != nil || resize.Sequence <= lastResizeSequence {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "invalid resize sequence", ErrProtocolViolation)
			}
			geometry, resizeErr := s.backend.Resize(ctx, attachment, resize)
			if resizeErr != nil {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeInternal, "terminal resize failed", resizeErr)
			}
			ack, encodeErr := EncodeResizeApplied(ResizeApplied{
				Sequence:               resize.Sequence,
				GeometryGeneration:     geometry.Generation,
				OutputSequenceBoundary: geometry.OutputSequenceBoundary,
				Cols:                   geometry.Cols,
				Rows:                   geometry.Rows,
			})
			if encodeErr != nil {
				return encodeErr
			}
			if err := writeBytes(ack); err != nil {
				return err
			}
			lastResizeSequence = resize.Sequence
		case FrameDetach:
			if len(frame.Payload) != 0 {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "invalid detach frame", ErrProtocolViolation)
			}
			return nil
		default:
			return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "unexpected client frame", ErrProtocolViolation)
		}
	}
}

func (s *Service) writeOutputs(
	ctx context.Context,
	stream io.ReadWriteCloser,
	writeMu *sync.Mutex,
	queue *outputQueue,
	sessionClosed <-chan struct{},
	superseded <-chan struct{},
) error {
	encodeCtx, cancelEncode := context.WithCancel(ctx)
	var encoderWG sync.WaitGroup
	encoderWG.Add(1)
	frames := make(chan encodedOutputFrame, MaxOutputBatchChunks)
	encoderDone := make(chan error, 1)
	go func() {
		defer encoderWG.Done()
		err := encodeOutputFrames(encodeCtx, queue, frames)
		close(frames)
		encoderDone <- err
	}()
	defer func() {
		queue.close()
		cancelEncode()
		encoderWG.Wait()
	}()

	var pendingFrame *encodedOutputFrame
	idle := true
	var window outputTimer
	defer func() {
		if window != nil {
			window.Stop()
		}
	}()
	for {
		var first encodedOutputFrame
		if idle {
			select {
			case <-ctx.Done():
				return nil
			case <-sessionClosed:
				return s.writeSessionClosed(stream, writeMu)
			case <-superseded:
				_ = s.protocolFailureLocked(stream, writeMu, ErrorCodeProtocolViolation, "terminal attachment superseded", ErrProtocolViolation)
				_ = stream.Close()
				return ErrProtocolViolation
			case frame, ok := <-frames:
				if !ok {
					return <-encoderDone
				}
				first = frame
			}
		} else if pendingFrame != nil {
			select {
			case <-ctx.Done():
				return nil
			case <-sessionClosed:
				return s.writeSessionClosed(stream, writeMu)
			case <-superseded:
				_ = s.protocolFailureLocked(stream, writeMu, ErrorCodeProtocolViolation, "terminal attachment superseded", ErrProtocolViolation)
				_ = stream.Close()
				return ErrProtocolViolation
			default:
				first = *pendingFrame
				pendingFrame = nil
			}
		} else {
			select {
			case <-ctx.Done():
				return nil
			case <-sessionClosed:
				return s.writeSessionClosed(stream, writeMu)
			case <-superseded:
				_ = s.protocolFailureLocked(stream, writeMu, ErrorCodeProtocolViolation, "terminal attachment superseded", ErrProtocolViolation)
				_ = stream.Close()
				return ErrProtocolViolation
			case <-window.Chan():
				window.Stop()
				window = nil
				idle = true
				continue
			case frame, ok := <-frames:
				if !ok {
					return <-encoderDone
				}
				first = frame
			}
		}

		var output encodedOutputWrite
		var nextPending *encodedOutputFrame
		if idle {
			output, nextPending = collectAvailableOutputFrames(first, frames)
		} else {
			output, nextPending = collectOutputFramesUntilDeadline(ctx, first, frames, window.Chan())
			window.Stop()
			window = nil
		}
		pendingFrame = nextPending
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		writeMu.Lock()
		err := writeAll(stream, output.data)
		writeMu.Unlock()
		if err != nil {
			return err
		}
		queue.takeBytes(output.queuedBytes)
		idle = false
		window = s.startOutputTimer(OutputCoalesceWindow)
	}
}

type outputTimer interface {
	Chan() <-chan time.Time
	Stop() bool
}

type standardOutputTimer struct {
	timer *time.Timer
}

func (t *standardOutputTimer) Chan() <-chan time.Time { return t.timer.C }
func (t *standardOutputTimer) Stop() bool             { return t.timer.Stop() }

func (s *Service) startOutputTimer(window time.Duration) outputTimer {
	if s != nil && s.newOutputTimer != nil {
		return s.newOutputTimer(window)
	}
	return &standardOutputTimer{timer: time.NewTimer(window)}
}

type encodedOutputFrame struct {
	data        []byte
	queuedBytes int
}

type encodedOutputWrite struct {
	data        []byte
	queuedBytes int
}

func encodeOutputFrames(ctx context.Context, queue *outputQueue, frames chan<- encodedOutputFrame) error {
	var pendingRecord *OutputRecord
	for {
		first, ok := takeNextOutputRecord(ctx, queue, &pendingRecord, true)
		if !ok {
			return nil
		}
		frame, nextPending, err := encodeOutputFrame(first, queue)
		if err != nil {
			return err
		}
		pendingRecord = nextPending
		select {
		case frames <- frame:
		case <-ctx.Done():
			return nil
		}
	}
}

func collectAvailableOutputFrames(
	first encodedOutputFrame,
	frames <-chan encodedOutputFrame,
) (encodedOutputWrite, *encodedOutputFrame) {
	output := encodedOutputWrite{
		data:        append([]byte(nil), first.data...),
		queuedBytes: first.queuedBytes,
	}
	for len(output.data) < maxOutputStreamBytes {
		select {
		case next, ok := <-frames:
			if !ok {
				return output, nil
			}
			if len(output.data)+len(next.data) > maxOutputStreamBytes {
				return output, &next
			}
			output.data = append(output.data, next.data...)
			output.queuedBytes += next.queuedBytes
		default:
			return output, nil
		}
	}
	return output, nil
}

func collectOutputFramesUntilDeadline(
	ctx context.Context,
	first encodedOutputFrame,
	frames <-chan encodedOutputFrame,
	deadline <-chan time.Time,
) (encodedOutputWrite, *encodedOutputFrame) {
	output := encodedOutputWrite{
		data:        append([]byte(nil), first.data...),
		queuedBytes: first.queuedBytes,
	}
	for len(output.data) < maxOutputStreamBytes {
		select {
		case <-deadline:
			return output, nil
		default:
		}
		select {
		case <-ctx.Done():
			return output, nil
		case <-deadline:
			return output, nil
		case next, ok := <-frames:
			if !ok {
				return output, nil
			}
			if len(output.data)+len(next.data) > maxOutputStreamBytes {
				return output, &next
			}
			output.data = append(output.data, next.data...)
			output.queuedBytes += next.queuedBytes
		}
	}
	return output, nil
}

func takeNextOutputRecord(
	ctx context.Context,
	queue *outputQueue,
	pending **OutputRecord,
	wait bool,
) (OutputRecord, bool) {
	if *pending != nil {
		record := **pending
		*pending = nil
		return record, true
	}
	if wait {
		select {
		case record := <-queue.items:
			return record, true
		case <-ctx.Done():
			return OutputRecord{}, false
		}
	}
	select {
	case record := <-queue.items:
		return record, true
	default:
		return OutputRecord{}, false
	}
}

func encodeOutputFrame(first OutputRecord, queue *outputQueue) (encodedOutputFrame, *OutputRecord, error) {
	records := []OutputRecord{first}
	dataBytes := len(first.Data)
	var pending *OutputRecord
drain:
	for len(records) < MaxOutputBatchChunks && dataBytes < MaxOutputBatchBytes {
		select {
		case next := <-queue.items:
			if next.GeometryGeneration != first.GeometryGeneration || next.Cols != first.Cols || next.Rows != first.Rows ||
				dataBytes+len(next.Data) > MaxOutputBatchBytes {
				pending = &next
				break drain
			}
			records = append(records, next)
			dataBytes += len(next.Data)
		default:
			break drain
		}
	}
	encoded, err := EncodeOutputBatch(OutputBatch{
		GeometryGeneration: first.GeometryGeneration,
		Cols:               first.Cols,
		Rows:               first.Rows,
		Records:            records,
	})
	if err != nil {
		return encodedOutputFrame{}, nil, err
	}
	return encodedOutputFrame{data: encoded, queuedBytes: dataBytes}, pending, nil
}

func (s *Service) writeSessionClosed(stream io.ReadWriteCloser, writeMu *sync.Mutex) error {
	closed, err := EncodeFrame(Frame{Type: FrameSessionClosed})
	if err == nil {
		writeMu.Lock()
		err = writeAll(stream, closed)
		writeMu.Unlock()
	}
	_ = stream.Close()
	return err
}

func (s *Service) protocolFailure(stream io.Writer, code uint16, message string, cause error) error {
	return s.protocolFailureLocked(stream, nil, code, message, cause)
}

func (s *Service) protocolFailureLocked(stream io.Writer, mu *sync.Mutex, code uint16, message string, cause error) error {
	encoded, err := EncodeProtocolError(ProtocolError{Code: code, Message: message})
	if err == nil {
		if mu != nil {
			mu.Lock()
			_ = writeAll(stream, encoded)
			mu.Unlock()
		} else {
			_ = writeAll(stream, encoded)
		}
	}
	if cause == nil {
		cause = ErrProtocolViolation
	}
	return fmt.Errorf("%s: %w", message, cause)
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
