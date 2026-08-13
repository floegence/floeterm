package terminal

import "errors"

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
	defer s.mu.Unlock()
	if s.semanticAttachments == nil {
		s.semanticAttachments = make(map[string]SemanticAttachment)
	}
	if current, ok := s.semanticAttachments[attachmentID]; ok && current.TransportGeneration >= generation {
		return ErrControllerTransport
	}
	if _, ok := s.semanticAttachments[attachmentID]; !ok && len(s.semanticAttachments) >= MaxSemanticAttachments {
		return ErrPresentationBackpressure
	}
	s.semanticAttachments[attachmentID] = SemanticAttachment{PrincipalID: principalID, TransportGeneration: generation}
	return nil
}

func (s *Session) LogicalDetachSemanticView(attachmentID string, generation uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.semanticAttachments[attachmentID]
	if !ok || current.TransportGeneration != generation {
		return false
	}
	delete(s.semanticAttachments, attachmentID)
	if s.controllerState.AttachmentID == attachmentID && s.controllerState.TransportGeneration == generation {
		s.controllerState = ControllerState{Epoch: s.controllerState.Epoch + 1}
	}
	return true
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
	err := writeTerminalInput(write, input)
	s.mu.Unlock()
	return err
}

func (s *Session) Controller() ControllerState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.controllerState
}
