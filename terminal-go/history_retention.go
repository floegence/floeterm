package terminal

import "errors"

var ErrHistoryRetentionUnavailable = errors.New("terminal history retention is unavailable")

// Nil fields preserve the engine defaults. Explicit zero is a zero budget.
// Native limits are page-granular and exclude the active screen.
type HistoryRetentionLimits struct {
	MaxLines *uint64 `json:"max_lines"`
	MaxBytes *uint64 `json:"max_bytes"`
}

func (l HistoryRetentionLimits) Validate() error {
	for _, value := range []*uint64{l.MaxLines, l.MaxBytes} {
		if value != nil && *value > 9007199254740991 {
			return errors.New("history retention exceeds safe integer range")
		}
	}
	return nil
}
func (l HistoryRetentionLimits) Clone() HistoryRetentionLimits {
	if l.MaxLines != nil {
		v := *l.MaxLines
		l.MaxLines = &v
	}
	if l.MaxBytes != nil {
		v := *l.MaxBytes
		l.MaxBytes = &v
	}
	return l
}

type HistoryRetentionState struct {
	Configured HistoryRetentionLimits `json:"configured"`
	Effective  HistoryRetentionLimits `json:"effective"`
	Defaults   HistoryRetentionLimits `json:"defaults"`
}
type SemanticHistoryRetentionEngine interface {
	HistoryRetentionDefaults() HistoryRetentionLimits
	HistoryRetention() (HistoryRetentionLimits, error)
	ConfigureHistoryRetention(HistoryRetentionLimits) error
}

func (a *SessionActor) HistoryRetention() (HistoryRetentionState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.historyRetentionLocked()
}
func (a *SessionActor) historyRetentionLocked() (HistoryRetentionState, error) {
	engine, ok := a.engine.(SemanticHistoryRetentionEngine)
	if !ok {
		return HistoryRetentionState{}, ErrHistoryRetentionUnavailable
	}
	effective, err := engine.HistoryRetention()
	return HistoryRetentionState{Configured: a.retention.Clone(), Effective: effective, Defaults: engine.HistoryRetentionDefaults()}, err
}

// ConfigureHistoryRetention preserves the PTY, screen, geometry and content epoch.
// Existing historical projections become invalid at the resulting actor cut.
func (a *SessionActor) ConfigureHistoryRetention(limits HistoryRetentionLimits) (HistoryRetentionState, SemanticPresentation, error) {
	if err := limits.Validate(); err != nil {
		return HistoryRetentionState{}, SemanticPresentation{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	engine, ok := a.engine.(SemanticHistoryRetentionEngine)
	if !ok {
		return HistoryRetentionState{}, SemanticPresentation{}, ErrHistoryRetentionUnavailable
	}
	if err := engine.ConfigureHistoryRetention(limits); err != nil {
		return HistoryRetentionState{}, SemanticPresentation{}, err
	}
	a.retention = limits.Clone()
	a.releaseAllHistoryLocked()
	frame, err := a.engine.CaptureFrame()
	if err != nil {
		return HistoryRetentionState{}, SemanticPresentation{}, err
	}
	a.sequence++
	frame.History.Revision = a.sequence
	a.updateHistoryIdentityLocked(&frame, true)
	a.geometry.PresentationSequence = a.sequence
	state := TerminalState{ContentEpoch: a.contentEpoch}
	if latest, exists := a.store.Latest(); exists {
		state = latest.State
	}
	state.Sequence = a.sequence
	p := SemanticPresentation{Sequence: a.sequence, Geometry: a.geometry, State: state, Frame: frame}
	if err := a.store.Publish(p); err != nil {
		return HistoryRetentionState{}, SemanticPresentation{}, err
	}
	retention, err := a.historyRetentionLocked()
	return retention, p, err
}

// SetHistoryRetentionDefaults changes only sessions created after this call.
func (m *Manager) SetHistoryRetentionDefaults(limits HistoryRetentionLimits) error {
	if err := limits.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config.HistoryRetention = limits.Clone()
	return nil
}
func (m *Manager) HistoryRetentionDefaults() HistoryRetentionLimits {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.config.HistoryRetention.Clone()
}
func (s *Session) HistoryRetention() (HistoryRetentionState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed || s.semanticActor == nil {
		return HistoryRetentionState{}, ErrHistoryRetentionUnavailable
	}
	return s.semanticActor.HistoryRetention()
}

// ConfigureHistoryRetention is attachment- and principal-bound, like clear.
// It does not acquire control or alter the canonical geometry.
func (s *Session) ConfigureHistoryRetention(attachmentID, principalID string, generation uint64, limits HistoryRetentionLimits) (HistoryRetentionState, error) {
	if err := limits.Validate(); err != nil {
		return HistoryRetentionState{}, err
	}
	if attachmentID == "" || principalID == "" || generation == 0 {
		return HistoryRetentionState{}, ErrControllerTransport
	}
	if err := s.beginPTYResize(); err != nil {
		return HistoryRetentionState{}, err
	}
	defer s.endPTYResize()
	s.mu.Lock()
	if s.closed || s.semanticActor == nil {
		s.mu.Unlock()
		return HistoryRetentionState{}, ErrHistoryRetentionUnavailable
	}
	attachment, ok := s.semanticAttachments[attachmentID]
	if !ok || attachment.TransportGeneration != generation || attachment.PrincipalID != principalID {
		s.mu.Unlock()
		return HistoryRetentionState{}, ErrControllerTransport
	}
	if state := s.controllerState; state.AttachmentID != "" && state.PrincipalID != principalID {
		s.mu.Unlock()
		return HistoryRetentionState{}, ErrControllerPrincipal
	}
	state, presentation, err := s.semanticActor.ConfigureHistoryRetention(limits)
	if err != nil {
		if !errors.Is(err, ErrHistoryRetentionUnavailable) {
			s.failClosedSemanticMutationLocked("history retention", err)
		}
		s.mu.Unlock()
		return HistoryRetentionState{}, err
	}
	s.latestPresentationSequence = presentation.Sequence
	s.mu.Unlock()
	s.broadcastPresentation(presentation, nil)
	return state, nil
}
