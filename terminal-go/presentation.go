package terminal

import (
	"errors"
	"sync"
)

var ErrPresentationBackpressure = errors.New("presentation reliable FIFO is full")

// SemanticPresentation is the only replaceable display unit for a v4 session.
// State and frame are published atomically and are always captured from one actor cut.
type SemanticPresentation struct {
	Sequence uint64
	Geometry TerminalGeometry
	State    TerminalState
	Frame    SemanticFrame
}

type TerminalState struct {
	Sequence uint64
	Title    string
	Bell     uint64
}

type SemanticFrame struct {
	Width      int
	Height     int
	Rows       []SemanticRow
	Cursor     SemanticCursor
	BufferKind string
	Graphics   []SemanticGraphic
}

type SemanticRow struct{ Cells []SemanticCell }
type SemanticCell struct {
	Text, Hyperlink string
	Width           uint8
	Style           SemanticStyle
}
type SemanticStyle struct {
	Foreground, Background  string
	Bold, Italic, Underline bool
}
type SemanticCursor struct {
	X, Y    int
	Visible bool
}
type SemanticGraphic struct {
	ID, Generation uint64
	Pixels         []byte
	Row, Column    int
}

func clonePresentation(in SemanticPresentation) SemanticPresentation {
	out := in
	out.Frame.Rows = append([]SemanticRow(nil), in.Frame.Rows...)
	for i := range out.Frame.Rows {
		out.Frame.Rows[i].Cells = append([]SemanticCell(nil), in.Frame.Rows[i].Cells...)
	}
	out.Frame.Graphics = append([]SemanticGraphic(nil), in.Frame.Graphics...)
	for i := range out.Frame.Graphics {
		out.Frame.Graphics[i].Pixels = append([]byte(nil), in.Frame.Graphics[i].Pixels...)
	}
	return out
}

// PresentationStore exposes atomic latest presentation plus a bounded reliable FIFO.
type PresentationStore struct {
	mu       sync.Mutex
	latest   SemanticPresentation
	queue    []SemanticPresentation
	capacity int
	closed   bool
}

func NewPresentationStore(capacity int) *PresentationStore {
	if capacity < 1 {
		capacity = 1
	}
	return &PresentationStore{capacity: capacity}
}

func (s *PresentationStore) Publish(p SemanticPresentation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errSessionClosed
	}
	s.latest = clonePresentation(p)
	if len(s.queue) >= s.capacity {
		return ErrPresentationBackpressure
	}
	s.queue = append(s.queue, clonePresentation(p))
	return nil
}

func (s *PresentationStore) Next() (SemanticPresentation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) == 0 {
		return SemanticPresentation{}, false
	}
	p := s.queue[0]
	s.queue = s.queue[1:]
	return clonePresentation(p), true
}

func (s *PresentationStore) Latest() (SemanticPresentation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.latest.Sequence == 0 {
		return SemanticPresentation{}, false
	}
	return clonePresentation(s.latest), true
}

func (s *PresentationStore) Close() { s.mu.Lock(); s.closed = true; s.queue = nil; s.mu.Unlock() }

func (s *Session) PublishPresentation(frame SemanticFrame, state TerminalState) error {
	if s == nil {
		return errSessionClosed
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errSessionClosed
	}
	if s.presentationStore == nil {
		s.presentationStore = NewPresentationStore(64)
	}
	nextSequence := s.sequenceNumber + 1
	presentation := SemanticPresentation{
		Sequence: uint64(nextSequence),
		Geometry: TerminalGeometry{Generation: s.geometryGeneration, OutputSequenceBoundary: s.committedSequence, Cols: s.lastAppliedCols, Rows: s.lastAppliedRows},
		Frame:    frame, State: state,
	}
	if err := s.presentationStore.Publish(presentation); err != nil {
		s.mu.Unlock()
		return err
	}
	s.sequenceNumber = nextSequence
	s.mu.Unlock()
	return nil
}

func (s *Session) LatestPresentation() (SemanticPresentation, bool) {
	if s == nil {
		return SemanticPresentation{}, false
	}
	s.mu.RLock()
	store := s.presentationStore
	s.mu.RUnlock()
	if store == nil {
		return SemanticPresentation{}, false
	}
	return store.Latest()
}
