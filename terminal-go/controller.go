package terminal

import (
	"errors"
	"fmt"
	"time"
)

var (
	ErrControllerEpoch     = errors.New("stale terminal controller epoch")
	ErrControllerTransport = errors.New("stale terminal transport generation")
	ErrControllerPrincipal = errors.New("terminal controller belongs to another principal")
)

type ControllerState struct {
	AttachmentID        string
	PrincipalID         string
	TransportGeneration uint64
	Epoch               uint64
}

// ControllerEpochMismatchError preserves the authoritative controller state
// for a rejected activation without applying the stale request.
type ControllerEpochMismatchError struct {
	Current ControllerState
}

func (e *ControllerEpochMismatchError) Error() string { return ErrControllerEpoch.Error() }
func (e *ControllerEpochMismatchError) Unwrap() error { return ErrControllerEpoch }

// ActivateSemanticView atomically transfers same-principal control, applies
// the activating view's viewport, and captures the matching Presentation.
func (s *Session) ActivateSemanticView(
	attachmentID string,
	principalID string,
	transportGeneration uint64,
	expectedEpoch uint64,
	cols int,
	rows int,
) (SemanticPresentation, ControllerState, error) {
	if s == nil || attachmentID == "" || principalID == "" || transportGeneration == 0 {
		return SemanticPresentation{}, ControllerState{}, ErrControllerTransport
	}
	if err := validateTerminalSize(cols, rows); err != nil {
		return SemanticPresentation{}, ControllerState{}, err
	}
	if err := s.beginPTYResize(); err != nil {
		return SemanticPresentation{}, ControllerState{}, err
	}

	s.mu.Lock()
	if s.closed || !s.isActive || s.semanticActor == nil {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ControllerState{}, errSessionClosed
	}
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != transportGeneration || attachment.PrincipalID != principalID {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ControllerState{}, ErrControllerTransport
	}
	state := s.controllerState
	if state.Epoch != expectedEpoch {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ControllerState{}, &ControllerEpochMismatchError{Current: state}
	}
	if state.AttachmentID != "" && state.PrincipalID != principalID {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ControllerState{}, ErrControllerPrincipal
	}
	nextController := state
	if state.AttachmentID != attachmentID || state.TransportGeneration != transportGeneration {
		nextController = ControllerState{
			AttachmentID: attachmentID, PrincipalID: principalID,
			TransportGeneration: transportGeneration, Epoch: state.Epoch + 1,
		}
	}
	geometry, presentation, hasPresentation, geometrySubscribers, err := s.applySemanticControllerSizeLocked(
		attachmentID, cols, rows, true,
	)
	if err != nil {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ControllerState{}, err
	}
	// The active semantic resize path either returns the exact matching
	// Presentation or rolls both engine and PTY geometry back with an error.
	// The preconditions above exclude its inactive/no-actor branch.
	if !hasPresentation || presentation.Sequence == 0 || presentation.Geometry != geometry {
		invariantErr := errors.New("semantic activation did not produce its canonical Presentation")
		s.failClosedResizeLocked(invariantErr)
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ControllerState{}, invariantErr
	}
	s.controllerState = nextController
	controllerSubscribers := s.liveSubscribersLocked()
	s.mu.Unlock()
	s.endPTYResize()
	if len(geometrySubscribers) > 0 {
		s.broadcastGeometry(geometry, geometrySubscribers)
	}
	s.broadcastPresentation(presentation, controllerSubscribers)
	s.broadcastController(nextController, controllerSubscribers)
	return presentation, nextController, nil
}

// ClearSemanticScreen validates the live attachment and serializes a native
// reset with PTY output. A same-principal observer may take control as one
// atomic action; stale transports and cross-principal requests have no effect.
func (s *Session) ClearSemanticScreen(attachmentID, principalID string, generation uint64) (SemanticPresentation, error) {
	if s == nil || attachmentID == "" || principalID == "" || generation == 0 {
		return SemanticPresentation{}, ErrControllerTransport
	}
	if err := s.beginPTYResize(); err != nil {
		return SemanticPresentation{}, err
	}
	s.mu.Lock()
	if s.closed || s.semanticActor == nil {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, errSessionClosed
	}
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != generation || attachment.PrincipalID != principalID {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ErrControllerTransport
	}
	state := s.controllerState
	if state.AttachmentID != "" && state.PrincipalID != principalID {
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, ErrControllerPrincipal
	}
	nextController := state
	if state.AttachmentID != attachmentID || state.TransportGeneration != generation {
		nextController = ControllerState{
			AttachmentID: attachmentID, PrincipalID: principalID,
			TransportGeneration: generation, Epoch: state.Epoch + 1,
		}
	}
	presentation, err := s.semanticActor.Clear()
	if err != nil {
		if !errors.Is(err, ErrSemanticClearUnavailable) {
			s.failClosedSemanticMutationLocked("clear", err)
		}
		s.mu.Unlock()
		s.endPTYResize()
		return SemanticPresentation{}, err
	}
	s.controllerState = nextController
	s.latestPresentationSequence = presentation.Sequence
	s.LastActive = time.Now()
	subscribers := s.liveSubscribersLocked()
	s.mu.Unlock()
	s.endPTYResize()
	s.broadcastPresentation(presentation, subscribers)
	s.broadcastController(nextController, subscribers)
	return presentation, nil
}

func (s *Session) failClosedSemanticMutationLocked(operation string, cause error) {
	s.closed = true
	s.outputClosed = true
	s.resizeQueued = false
	if s.cancel != nil {
		s.cancel()
	}
	s.config.logger.Error("Terminal session failed closed after semantic mutation", "sessionID", s.ID, "operation", operation, "error", cause)
}

const MaxSemanticAttachments = 64

type SemanticAttachment struct {
	PrincipalID         string
	TransportGeneration uint64
}

func (s *Session) AttachSemanticView(attachmentID, principalID string, generation uint64) error {
	if s == nil || attachmentID == "" || principalID == "" || generation == 0 {
		return ErrControllerTransport
	}
	s.mu.Lock()
	if s.semanticAttachments == nil {
		s.semanticAttachments = make(map[string]SemanticAttachment)
	}
	if current, ok := s.semanticAttachments[attachmentID]; ok && current.TransportGeneration >= generation {
		s.mu.Unlock()
		return ErrControllerTransport
	}
	if _, ok := s.semanticAttachments[attachmentID]; !ok && len(s.semanticAttachments) >= MaxSemanticAttachments {
		s.mu.Unlock()
		return ErrPresentationBackpressure
	}
	previous, replaced := s.semanticAttachments[attachmentID]
	s.semanticAttachments[attachmentID] = SemanticAttachment{PrincipalID: principalID, TransportGeneration: generation}
	actor := s.semanticActor
	s.mu.Unlock()
	if replaced && previous.TransportGeneration != generation && actor != nil {
		actor.ReleaseHistory(semanticHistoryViewID(attachmentID, previous.TransportGeneration))
	}
	return nil
}

func (s *Session) EnsureSemanticController(attachmentID, principalID string, generation uint64) ControllerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.controllerState.AttachmentID == "" {
		s.controllerState = ControllerState{AttachmentID: attachmentID, PrincipalID: principalID, TransportGeneration: generation, Epoch: 1}
	}
	return s.controllerState
}

func (s *Session) LogicalDetachSemanticView(attachmentID string, generation uint64) bool {
	s.mu.Lock()
	current, ok := s.semanticAttachments[attachmentID]
	if !ok || current.TransportGeneration != generation {
		s.mu.Unlock()
		return false
	}
	delete(s.semanticAttachments, attachmentID)
	controllerChanged := s.controllerState.AttachmentID == attachmentID && s.controllerState.TransportGeneration == generation
	if controllerChanged {
		s.controllerState = ControllerState{Epoch: s.controllerState.Epoch + 1}
	}
	actor := s.semanticActor
	controller := s.controllerState
	subscribers := s.liveSubscribersLocked()
	s.mu.Unlock()
	if actor != nil {
		actor.ReleaseHistory(semanticHistoryViewID(attachmentID, generation))
	}
	if controllerChanged {
		s.broadcastController(controller, subscribers)
	}
	return true
}

func semanticHistoryViewID(attachmentID string, generation uint64) string {
	return fmt.Sprintf("%s/%d", attachmentID, generation)
}

// ReadSemanticHistory validates the current transport and enters the same
// actor ownership window as PTY output, input, and resize. The request never
// reads Ghostty concurrently and never exposes native tracked references.
func (s *Session) ReadSemanticHistory(attachmentID string, generation uint64, request SemanticHistoryRequest) (SemanticHistoryChunk, error) {
	if s == nil || attachmentID == "" || generation == 0 {
		return SemanticHistoryChunk{}, ErrControllerTransport
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != generation {
		return SemanticHistoryChunk{}, ErrControllerTransport
	}
	if s.closed || s.semanticActor == nil {
		return SemanticHistoryChunk{}, errSessionClosed
	}
	request.ViewID = semanticHistoryViewID(attachmentID, generation)
	chunk, err := s.semanticActor.ReadHistory(request)
	if err != nil {
		return SemanticHistoryChunk{}, err
	}
	chunk.TransportGeneration = generation
	return chunk, nil
}

// Interact atomically validates transport/epoch and permits same-principal takeover.
func (s *Session) Interact(attachmentID, principalID string, transportGeneration, epoch uint64, input []byte) error {
	return s.InteractSemantic(attachmentID, principalID, transportGeneration, epoch, SemanticInput{Kind: "bytes", Data: input})
}

// InteractSemanticView atomically activates the current attachment at its last
// recorded viewport before admitting input. It is the fallback for a real
// keyboard interaction that races another view's explicit activation.
func (s *Session) InteractSemanticView(
	attachmentID string,
	principalID string,
	transportGeneration uint64,
	input SemanticInput,
) error {
	if s == nil || attachmentID == "" || principalID == "" || transportGeneration == 0 {
		return ErrControllerTransport
	}
	if err := validateSemanticInput(input); err != nil {
		return err
	}

	// The steady-state controller input path already serializes with PTY output
	// through the session/actor lock. Enter the heavier PTY resize ownership
	// window only when this interaction must transfer controller geometry.
	s.mu.Lock()
	state, err := s.semanticInteractionStateLocked(attachmentID, principalID, transportGeneration)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if state.AttachmentID == attachmentID && state.TransportGeneration == transportGeneration {
		_, inputErr := s.applySemanticInputLocked(input)
		s.mu.Unlock()
		return inputErr
	}
	s.mu.Unlock()

	if err := s.beginPTYResize(); err != nil {
		return err
	}

	s.mu.Lock()
	state, err = s.semanticInteractionStateLocked(attachmentID, principalID, transportGeneration)
	if err != nil {
		s.mu.Unlock()
		s.endPTYResize()
		return err
	}

	var geometry TerminalGeometry
	var presentation SemanticPresentation
	var geometrySubscribers []LiveSubscriber
	var controllerSubscribers []LiveSubscriber
	controllerChanged := state.AttachmentID != attachmentID || state.TransportGeneration != transportGeneration
	if controllerChanged {
		connection, exists := s.connections[attachmentID]
		if !exists {
			s.mu.Unlock()
			s.endPTYResize()
			return ErrControllerTransport
		}
		var hasPresentation bool
		var err error
		geometry, presentation, hasPresentation, geometrySubscribers, err = s.applySemanticControllerSizeLocked(
			attachmentID, connection.Cols, connection.Rows, true,
		)
		if err != nil {
			s.mu.Unlock()
			s.endPTYResize()
			return err
		}
		if !hasPresentation || presentation.Sequence == 0 || presentation.Geometry != geometry {
			invariantErr := errors.New("semantic input activation did not produce its canonical Presentation")
			s.failClosedResizeLocked(invariantErr)
			s.mu.Unlock()
			s.endPTYResize()
			return invariantErr
		}
		s.controllerState = ControllerState{
			AttachmentID: attachmentID, PrincipalID: principalID,
			TransportGeneration: transportGeneration, Epoch: state.Epoch + 1,
		}
		controllerSubscribers = s.liveSubscribersLocked()
	}

	_, inputErr := s.applySemanticInputLocked(input)
	controller := s.controllerState
	s.mu.Unlock()
	s.endPTYResize()
	if controllerChanged {
		if len(geometrySubscribers) > 0 {
			s.broadcastGeometry(geometry, geometrySubscribers)
		}
		s.broadcastPresentation(presentation, controllerSubscribers)
		s.broadcastController(controller, controllerSubscribers)
	}
	return inputErr
}

func (s *Session) semanticInteractionStateLocked(
	attachmentID string,
	principalID string,
	transportGeneration uint64,
) (ControllerState, error) {
	if s.closed || !s.isActive || s.PTY == nil {
		return ControllerState{}, errSessionClosed
	}
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != transportGeneration || attachment.PrincipalID != principalID {
		return ControllerState{}, ErrControllerTransport
	}
	state := s.controllerState
	if state.AttachmentID != "" && state.PrincipalID != principalID {
		return ControllerState{}, ErrControllerPrincipal
	}
	return state, nil
}

// InteractSemantic admits one structured input through the current attachment
// and lets the actor-owned Ghostty encoder resolve terminal modes.
func (s *Session) InteractSemantic(attachmentID, principalID string, transportGeneration, epoch uint64, input SemanticInput) error {
	if s == nil || attachmentID == "" || principalID == "" || transportGeneration == 0 {
		return ErrControllerTransport
	}
	s.mu.Lock()
	if s.closed || s.PTY == nil {
		s.mu.Unlock()
		return errSessionClosed
	}
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != transportGeneration || attachment.PrincipalID != principalID {
		s.mu.Unlock()
		return ErrControllerTransport
	}
	state := s.controllerState
	if state.AttachmentID != "" {
		if state.Epoch != epoch {
			s.mu.Unlock()
			return ErrControllerEpoch
		}
		if state.PrincipalID != principalID {
			s.mu.Unlock()
			return ErrControllerPrincipal
		}
	} else if epoch != 0 {
		s.mu.Unlock()
		return ErrControllerEpoch
	}
	inputCommitted, err := s.applySemanticInputLocked(input)
	controllerChanged := err == nil && inputCommitted && (state.AttachmentID == "" || state.AttachmentID != attachmentID || state.TransportGeneration != transportGeneration)
	var controllerSubscribers []LiveSubscriber
	if controllerChanged {
		s.controllerState = ControllerState{AttachmentID: attachmentID, PrincipalID: principalID, TransportGeneration: transportGeneration, Epoch: state.Epoch + 1}
		controllerSubscribers = s.liveSubscribersLocked()
	}
	controller := s.controllerState
	s.mu.Unlock()
	if controllerChanged {
		s.broadcastController(controller, controllerSubscribers)
	}
	return err
}

func (s *Session) applySemanticInputLocked(input SemanticInput) (bool, error) {
	write := s.writePTY
	if write == nil {
		write = s.PTY.Write
	}
	inputCommitted := false
	if s.semanticActor != nil {
		err := s.semanticActor.Input(input, func(encoded []byte) error {
			if writeErr := writeTerminalInput(write, encoded); writeErr != nil {
				return writeErr
			}
			inputCommitted = true
			return nil
		})
		return inputCommitted, err
	}
	var data []byte
	switch input.Kind {
	case "bytes":
		data = input.Data
	case "text":
		data = []byte(input.Text)
	default:
		return false, errors.New("structured terminal input requires the semantic actor")
	}
	err := writeTerminalInput(write, data)
	return err == nil, err
}

func (s *Session) Controller() ControllerState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.controllerState
}

func (s *Session) SemanticAttachmentGeneration(attachmentID string) (uint64, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.semanticAttachments[attachmentID]
	return a.TransportGeneration, ok
}

func (s *Session) RecordSemanticViewSize(attachmentID string, generation uint64, cols, rows int) error {
	if s == nil || attachmentID == "" || generation == 0 {
		return ErrControllerTransport
	}
	if err := validateTerminalSize(cols, rows); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != generation {
		return ErrControllerTransport
	}
	connection, ok := s.connections[attachmentID]
	if !ok {
		return ErrControllerTransport
	}
	connection.Cols, connection.Rows = cols, rows
	return nil
}

func (s *Session) SemanticViewSize(attachmentID string, generation uint64) (int, int, error) {
	if s == nil || attachmentID == "" || generation == 0 {
		return 0, 0, ErrControllerTransport
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != generation {
		return 0, 0, ErrControllerTransport
	}
	connection, ok := s.connections[attachmentID]
	if !ok {
		return 0, 0, ErrControllerTransport
	}
	return connection.Cols, connection.Rows, nil
}
