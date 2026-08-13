package terminal

import (
	"errors"
	"fmt"
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

func (a *SessionActor) PublishInitialPresentation() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.sequence != 0 {
		return nil
	}
	frame, err := a.engine.CaptureFrame()
	if err != nil {
		return err
	}
	a.sequence = 1
	return a.store.Publish(SemanticPresentation{Sequence: 1, Geometry: a.geometry, State: TerminalState{Sequence: 1}, Frame: frame})
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
	next := a.geometry
	next.Generation++
	next.Cols, next.Rows = cols, rows
	_, err := a.resizeToGeometryLocked(next)
	return err
}

// ResizeToGeometry applies the canonical geometry chosen by the session. The
// actor owns the mutable engine, but it must not create a second geometry
// generation independent from the PTY/session authority.
func (a *SessionActor) ResizeToGeometry(geometry TerminalGeometry) error {
	_, err := a.ResizeToGeometryAndCapture(geometry)
	return err
}

// ResizeToGeometryAndCapture returns the immutable Presentation produced by
// this exact actor cut. Callers must broadcast this value rather than reading
// a shared latest slot that may already contain another actor event.
func (a *SessionActor) ResizeToGeometryAndCapture(geometry TerminalGeometry) (SemanticPresentation, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.resizeToGeometryLocked(geometry)
}

func (a *SessionActor) resizeToGeometryLocked(geometry TerminalGeometry) (SemanticPresentation, error) {
	if geometry.Generation == 0 || geometry.Cols <= 0 || geometry.Rows <= 0 {
		return SemanticPresentation{}, errors.New("invalid semantic resize")
	}
	previousGeometry := a.geometry
	if err := a.engine.Resize(geometry.Cols, geometry.Rows); err != nil {
		return SemanticPresentation{}, err
	}
	frame, err := a.engine.CaptureFrame()
	if err != nil {
		return SemanticPresentation{}, a.rollbackResizeLocked(previousGeometry, err)
	}
	if frame.Width != geometry.Cols || frame.Height != geometry.Rows {
		return SemanticPresentation{}, a.rollbackResizeLocked(previousGeometry,
			fmt.Errorf("semantic frame geometry %dx%d does not match resize %dx%d", frame.Width, frame.Height, geometry.Cols, geometry.Rows))
	}
	presentation := SemanticPresentation{Sequence: a.sequence + 1, Geometry: geometry, State: TerminalState{Sequence: a.sequence + 1}, Frame: frame}
	if err := a.store.Publish(presentation); err != nil {
		return SemanticPresentation{}, a.rollbackResizeLocked(previousGeometry, err)
	}
	a.geometry = geometry
	a.sequence++
	return presentation, nil
}

func (a *SessionActor) rollbackResizeLocked(previous TerminalGeometry, cause error) error {
	if previous.Cols <= 0 || previous.Rows <= 0 {
		return fmt.Errorf("semantic resize failed: %w", cause)
	}
	if rollbackErr := a.engine.Resize(previous.Cols, previous.Rows); rollbackErr != nil {
		return fmt.Errorf("semantic resize failed: %w; rollback failed: %v", cause, rollbackErr)
	}
	return fmt.Errorf("semantic resize failed: %w", cause)
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
