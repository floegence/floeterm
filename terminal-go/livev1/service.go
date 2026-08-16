package livev1

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	maxReliableServerEvents = 256

	ErrorCodeProtocolViolation   uint16 = 1
	ErrorCodePermissionDenied    uint16 = 2
	ErrorCodeSessionNotFound     uint16 = 3
	ErrorCodeActivationFailed    uint16 = 4
	ErrorCodeSlowConsumer        uint16 = 5
	ErrorCodeInternal            uint16 = 6
	ErrorCodeControllerEpoch     uint16 = 7
	ErrorCodeControllerTransport uint16 = 8
	ErrorCodeControllerPrincipal uint16 = 9
)

var (
	ErrProtocolViolation   = errors.New("terminal live protocol violation")
	ErrPermissionDenied    = errors.New("terminal live permission denied")
	ErrSessionNotFound     = errors.New("terminal live session not found")
	ErrActivationFailed    = errors.New("terminal live activation failed")
	ErrSlowConsumer        = errors.New("terminal live slow consumer")
	ErrControllerEpoch     = errors.New("terminal live stale controller epoch")
	ErrControllerTransport = errors.New("terminal live stale controller transport")
	ErrControllerPrincipal = errors.New("terminal live controller principal mismatch")
)

type Subscriber struct {
	OnGeometry      func(EffectiveGeometry) bool
	OnController    func(EffectiveController) bool
	OnPresentation  func([]byte) bool
	OnSessionClosed func()
	OnSuperseded    func()
}

type Backend interface {
	Attach(ctx context.Context, request Attach, subscriber Subscriber) (Attached, func(), error)
	WriteInput(ctx context.Context, attachment Attach, input Input) error
	Resize(ctx context.Context, attachment Attach, resize Resize) (EffectiveGeometry, error)
}

type InputIntentBackend interface {
	WriteInputIntent(ctx context.Context, attachment Attach, input InputIntent) error
}

type PasteInputBackend interface {
	WritePaste(ctx context.Context, attachment Attach, input PasteInput) error
}

type ActivationBackend interface {
	Activate(ctx context.Context, attachment Attach, activate Activate) (Activated, error)
}

// ControllerEpochMismatchError is a recoverable command conflict. The stale
// activation has no effect; the connection remains live and receives the
// authoritative epoch needed to settle its still-current user intent.
type ControllerEpochMismatchError struct {
	Controller EffectiveController
}

func (e *ControllerEpochMismatchError) Error() string { return ErrControllerEpoch.Error() }
func (e *ControllerEpochMismatchError) Unwrap() error { return ErrControllerEpoch }

type Service struct{ backend Backend }

func NewService(backend Backend) *Service { return &Service{backend: backend} }

type serverEvent struct {
	kind       FrameType
	geometry   EffectiveGeometry
	controller EffectiveController
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

	var writeMu sync.Mutex
	writeBytes := func(data []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeAll(stream, data)
	}

	reliable := make(chan serverEvent, maxReliableServerEvents)
	presentationWake := make(chan struct{}, 1)
	var presentationMu sync.Mutex
	var latestPresentation []byte
	var preAttachMu sync.Mutex
	attachedWritten := false
	var pendingGeometry *EffectiveGeometry
	var pendingController *EffectiveController
	var pendingPresentation []byte

	failConnection := func() {
		cancel()
		_ = stream.Close()
	}
	enqueueReliable := func(event serverEvent) bool {
		select {
		case reliable <- event:
			return true
		default:
			failConnection()
			return false
		}
	}
	queueGeometry := func(geometry EffectiveGeometry) bool {
		preAttachMu.Lock()
		if !attachedWritten {
			copyGeometry := geometry
			pendingGeometry = &copyGeometry
			preAttachMu.Unlock()
			return true
		}
		preAttachMu.Unlock()
		return enqueueReliable(serverEvent{kind: FrameGeometryChanged, geometry: geometry})
	}
	queuePresentation := func(data []byte) bool {
		owned := append([]byte(nil), data...)
		preAttachMu.Lock()
		if !attachedWritten {
			pendingPresentation = owned
			preAttachMu.Unlock()
			return true
		}
		preAttachMu.Unlock()
		presentationMu.Lock()
		latestPresentation = owned
		presentationMu.Unlock()
		select {
		case presentationWake <- struct{}{}:
		default:
		}
		return true
	}
	queueController := func(controller EffectiveController) bool {
		preAttachMu.Lock()
		if !attachedWritten {
			copyController := controller
			pendingController = &copyController
			preAttachMu.Unlock()
			return true
		}
		preAttachMu.Unlock()
		return enqueueReliable(serverEvent{kind: FrameControllerChanged, controller: controller})
	}

	attached, detach, err := s.backend.Attach(ctx, attachment, Subscriber{
		OnGeometry:     queueGeometry,
		OnController:   queueController,
		OnPresentation: queuePresentation,
		OnSessionClosed: func() {
			enqueueReliable(serverEvent{kind: FrameSessionClosed})
		},
		OnSuperseded: func() {
			enqueueReliable(serverEvent{kind: FrameError})
		},
	})
	if err != nil {
		code, message := ErrorCodeInternal, "terminal attach failed"
		switch {
		case errors.Is(err, ErrPermissionDenied):
			code, message = ErrorCodePermissionDenied, "terminal permission denied"
		case errors.Is(err, ErrSessionNotFound):
			code, message = ErrorCodeSessionNotFound, "terminal session not found"
		case errors.Is(err, ErrActivationFailed):
			code, message = ErrorCodeActivationFailed, "terminal activation failed"
		}
		return s.protocolFailure(stream, uint16(code), message, err)
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
	preAttachMu.Lock()
	attachedWritten = true
	geometry := pendingGeometry
	controller := pendingController
	presentation := pendingPresentation
	pendingGeometry = nil
	pendingController = nil
	pendingPresentation = nil
	preAttachMu.Unlock()
	if geometry != nil && geometry.Generation > attached.GeometryGeneration && !queueGeometry(*geometry) {
		return ErrSlowConsumer
	}
	if controller != nil && controller.Epoch > attached.ControllerEpoch && !queueController(*controller) {
		return ErrSlowConsumer
	}
	if len(presentation) > 0 && !queuePresentation(presentation) {
		return ErrSlowConsumer
	}

	writerDone := make(chan error, 1)
	go func() {
		writerDone <- s.writeServerEvents(ctx, stream, &writeMu, reliable, presentationWake, &presentationMu, &latestPresentation)
	}()

	var lastInputSequence uint64
	var lastResizeSequence uint64
	var lastActivationSequence uint64
	var pasteBuffer []byte
	for {
		frame, readErr := ReadFrame(stream)
		if readErr != nil {
			select {
			case writerErr := <-writerDone:
				if writerErr != nil && !errors.Is(writerErr, io.ErrClosedPipe) {
					return writerErr
				}
			default:
			}
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrClosedPipe) || errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return readErr
		}
		if pasteBuffer != nil && frame.Type != FramePaste {
			return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "paste input was interrupted", ErrProtocolViolation)
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
		case FrameInputIntent:
			input, decodeErr := DecodeInputIntent(frame)
			if decodeErr != nil || input.Sequence <= lastInputSequence {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "invalid input intent sequence", ErrProtocolViolation)
			}
			backend, ok := s.backend.(InputIntentBackend)
			if !ok {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeInternal, "terminal input intent is unavailable", ErrActivationFailed)
			}
			if err := backend.WriteInputIntent(ctx, attachment, input); err != nil {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeInternal, "terminal input intent failed", err)
			}
			lastInputSequence = input.Sequence
		case FramePaste:
			chunk, decodeErr := DecodePasteChunk(frame)
			if decodeErr != nil || chunk.Sequence <= lastInputSequence {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "invalid paste input sequence", ErrProtocolViolation)
			}
			if pasteBuffer != nil && chunk.Sequence != lastInputSequence+1 {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "non-contiguous paste input sequence", ErrProtocolViolation)
			}
			if chunk.Start {
				if pasteBuffer != nil {
					return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "duplicate paste start", ErrProtocolViolation)
				}
				pasteBuffer = make([]byte, 0, min(len(chunk.Data), MaxPasteBytes))
			} else if pasteBuffer == nil {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "paste continuation has no start", ErrProtocolViolation)
			}
			if len(chunk.Data) > MaxPasteBytes-len(pasteBuffer) {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "paste input exceeds limit", ErrProtocolViolation)
			}
			pasteBuffer = append(pasteBuffer, chunk.Data...)
			lastInputSequence = chunk.Sequence
			if chunk.End {
				backend, ok := s.backend.(PasteInputBackend)
				if !ok {
					return s.protocolFailureLocked(stream, &writeMu, ErrorCodeInternal, "terminal paste input is unavailable", ErrActivationFailed)
				}
				input := PasteInput{Sequence: chunk.Sequence, Data: pasteBuffer}
				pasteBuffer = nil
				if err := backend.WritePaste(ctx, attachment, input); err != nil {
					return s.protocolFailureLocked(stream, &writeMu, ErrorCodeInternal, "terminal paste input failed", err)
				}
			}
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
				Sequence: resize.Sequence, GeometryGeneration: geometry.Generation,
				PresentationSequence: geometry.PresentationSequence, Cols: geometry.Cols, Rows: geometry.Rows,
			})
			if encodeErr != nil {
				return encodeErr
			}
			if err := writeBytes(ack); err != nil {
				return err
			}
			lastResizeSequence = resize.Sequence
		case FrameActivate:
			activate, decodeErr := DecodeActivate(frame)
			if decodeErr != nil || activate.Sequence <= lastActivationSequence {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeProtocolViolation, "invalid activation sequence", ErrProtocolViolation)
			}
			backend, ok := s.backend.(ActivationBackend)
			if !ok {
				return s.protocolFailureLocked(stream, &writeMu, ErrorCodeActivationFailed, "terminal view activation is unavailable", ErrActivationFailed)
			}
			activated, activateErr := backend.Activate(ctx, attachment, activate)
			if activateErr != nil {
				var mismatch *ControllerEpochMismatchError
				if errors.As(activateErr, &mismatch) && mismatch.Controller.Epoch > 0 {
					rejected, encodeErr := EncodeActivationRejected(ActivationRejected{
						Sequence: activate.Sequence, Controller: mismatch.Controller,
					})
					if encodeErr != nil {
						return encodeErr
					}
					if err := writeBytes(rejected); err != nil {
						return err
					}
					lastActivationSequence = activate.Sequence
					continue
				}
				code, message := ErrorCodeInternal, "terminal view activation failed"
				switch {
				case errors.Is(activateErr, ErrControllerEpoch):
					code, message = ErrorCodeControllerEpoch, "stale terminal controller epoch"
				case errors.Is(activateErr, ErrControllerTransport):
					code, message = ErrorCodeControllerTransport, "stale terminal transport generation"
				case errors.Is(activateErr, ErrControllerPrincipal):
					code, message = ErrorCodeControllerPrincipal, "terminal controller belongs to another principal"
				}
				return s.protocolFailureLocked(stream, &writeMu, uint16(code), message, activateErr)
			}
			ack, encodeErr := EncodeActivated(activated)
			if encodeErr != nil {
				return encodeErr
			}
			if err := writeBytes(ack); err != nil {
				return err
			}
			lastActivationSequence = activate.Sequence
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

func (s *Service) writeServerEvents(
	ctx context.Context,
	stream io.ReadWriteCloser,
	writeMu *sync.Mutex,
	reliable <-chan serverEvent,
	presentationWake <-chan struct{},
	presentationMu *sync.Mutex,
	latestPresentation *[]byte,
) error {
	for {
		select {
		case event := <-reliable:
			if err := s.writeReliableServerEvent(stream, writeMu, event); err != nil {
				return err
			}
		default:
			select {
			case <-ctx.Done():
				return nil
			case event := <-reliable:
				if err := s.writeReliableServerEvent(stream, writeMu, event); err != nil {
					return err
				}
			case <-presentationWake:
				presentationMu.Lock()
				data := append([]byte(nil), (*latestPresentation)...)
				presentationMu.Unlock()
				encoded, err := EncodeFrame(Frame{Type: FramePresentation, Payload: data})
				if err != nil {
					return err
				}
				writeMu.Lock()
				err = writeAll(stream, encoded)
				writeMu.Unlock()
				if err != nil {
					return err
				}
			}
		}
	}
}

func (s *Service) writeReliableServerEvent(
	stream io.ReadWriteCloser,
	writeMu *sync.Mutex,
	event serverEvent,
) error {
	switch event.kind {
	case FrameGeometryChanged:
		encoded, err := EncodeGeometryChanged(event.geometry)
		if err != nil {
			return err
		}
		writeMu.Lock()
		err = writeAll(stream, encoded)
		writeMu.Unlock()
		return err
	case FrameControllerChanged:
		encoded, err := EncodeControllerChanged(event.controller)
		if err != nil {
			return err
		}
		writeMu.Lock()
		err = writeAll(stream, encoded)
		writeMu.Unlock()
		return err
	case FrameSessionClosed:
		return s.writeSessionClosed(stream, writeMu)
	case FrameError:
		_ = s.protocolFailureLocked(stream, writeMu, ErrorCodeProtocolViolation, "terminal attachment superseded", ErrProtocolViolation)
		_ = stream.Close()
		return ErrProtocolViolation
	default:
		return fmt.Errorf("unsupported reliable server event: %d", event.kind)
	}
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
