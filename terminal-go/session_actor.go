package terminal

import (
	"errors"
	"sync"
)

type SemanticEngine interface {
	ApplyOutput([]byte) (TerminalState, error)
	CaptureFrame() (SemanticFrame, error)
	Resize(cols, rows int) error
	EncodeInput(SemanticInput) ([]byte, error)
	Close()
}

type SemanticInput struct {
	Kind, Text string
	Focused    bool
	X, Y       float32
}

// SessionActor is the single mutable owner of PTY admission and the VT engine.
type SessionActor struct {
	mu       sync.Mutex
	engine   SemanticEngine
	store    *PresentationStore
	geometry TerminalGeometry
	sequence uint64
}

func NewSessionActor(engine SemanticEngine, cols, rows int, store *PresentationStore) (*SessionActor, error) {
	if engine == nil || cols <= 0 || rows <= 0 || store == nil {
		return nil, errors.New("invalid semantic session actor")
	}
	return &SessionActor{engine: engine, store: store, geometry: TerminalGeometry{Generation: 1, Cols: cols, Rows: rows}}, nil
}

func (a *SessionActor) ApplyPTYOutput(data []byte) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.engine.ApplyOutput(data)
	if err != nil {
		return err
	}
	frame, err := a.engine.CaptureFrame()
	if err != nil {
		return err
	}
	a.sequence++
	state.Sequence = a.sequence
	p := SemanticPresentation{Sequence: a.sequence, Geometry: a.geometry, State: state, Frame: frame}
	return a.store.Publish(p)
}

func (a *SessionActor) Resize(cols, rows int) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if cols <= 0 || rows <= 0 {
		return errors.New("invalid semantic resize")
	}
	if err := a.engine.Resize(cols, rows); err != nil {
		return err
	}
	a.geometry.Generation++
	a.geometry.Cols, a.geometry.Rows = cols, rows
	return nil
}

func (a *SessionActor) Input(intent SemanticInput, write func([]byte) error) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	encoded, err := a.engine.EncodeInput(intent)
	if err != nil {
		return err
	}
	return write(encoded)
}

func (a *SessionActor) Close() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.engine != nil {
		a.engine.Close()
		a.engine = nil
	}
	if a.store != nil {
		a.store.Close()
	}
}
