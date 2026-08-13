package terminal

import (
	"errors"
	"fmt"
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
	if s.controllerState.AttachmentID == attachmentID && s.controllerState.TransportGeneration == generation {
		s.controllerState = ControllerState{Epoch: s.controllerState.Epoch + 1}
	}
	actor := s.semanticActor
	s.mu.Unlock()
	if actor != nil {
		actor.ReleaseHistory(semanticHistoryViewID(attachmentID, generation))
	}
	return true
}

func semanticHistoryViewID(attachmentID string, generation uint64) string {
	return fmt.Sprintf("%s/%d", attachmentID, generation)
}

// ReadSemanticHistory validates the current transport and enters the same
// actor ownership window as PTY output, input, and resize. The request never
// reads Ghostty concurrently and never exposes native tracked references.
func (s *Session) ReadSemanticHistory(attachmentID string, generation uint64, request SemanticHistoryRequest) (SemanticHistoryPage, error) {
	if s == nil || attachmentID == "" || generation == 0 {
		return SemanticHistoryPage{}, ErrControllerTransport
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != generation {
		return SemanticHistoryPage{}, ErrControllerTransport
	}
	if s.closed || s.semanticActor == nil {
		return SemanticHistoryPage{}, errSessionClosed
	}
	request.ViewID = semanticHistoryViewID(attachmentID, generation)
	return s.semanticActor.ReadHistory(request)
}

// Interact atomically validates transport/epoch and permits same-principal takeover.
func (s *Session) Interact(attachmentID, principalID string, transportGeneration, epoch uint64, input []byte) error {
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
	if state.AttachmentID == "" || state.AttachmentID != attachmentID {
		s.controllerState = ControllerState{AttachmentID: attachmentID, PrincipalID: principalID, TransportGeneration: transportGeneration, Epoch: state.Epoch + 1}
	}
	write := s.writePTY
	if write == nil {
		write = s.PTY.Write
	}
	var err error
	if s.semanticActor != nil {
		err = s.semanticActor.Input(SemanticInput{Kind: "text", Text: string(input)}, func(encoded []byte) error {
			return writeTerminalInput(write, encoded)
		})
	} else {
		err = writeTerminalInput(write, input)
	}
	s.mu.Unlock()
	return err
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
