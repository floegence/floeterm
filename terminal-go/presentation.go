package terminal

import (
	"encoding/json"
	"errors"
	"sync"
)

func EncodeSemanticPresentation(p SemanticPresentation) ([]byte, error) {
	type wireCell [4]any
	type wireStyle [5]any
	styles := make([]wireStyle, 0, 16)
	styleIndex := make(map[SemanticStyle]int)
	rows := make([][]wireCell, len(p.Frame.Rows))
	for y, row := range p.Frame.Rows {
		rows[y] = make([]wireCell, len(row.Cells))
		for x, cell := range row.Cells {
			index, ok := styleIndex[cell.Style]
			if !ok {
				index = len(styles)
				styleIndex[cell.Style] = index
				styles = append(styles, wireStyle{cell.Style.Foreground, cell.Style.Background, cell.Style.Bold, cell.Style.Italic, cell.Style.Underline})
			}
			rows[y][x] = wireCell{cell.Text, cell.Width, index, cell.Hyperlink}
		}
	}
	wire := map[string]any{
		"v": 1, "sequence": p.Sequence, "geometry": p.Geometry, "state": p.State,
		"frame": map[string]any{"width": p.Frame.Width, "height": p.Frame.Height, "bufferKind": p.Frame.BufferKind, "cursor": p.Frame.Cursor, "styles": styles, "rows": rows},
	}
	data, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data) > 256*1024 {
		return nil, ErrPresentationBackpressure
	}
	return data, nil
}

var ErrPresentationBackpressure = errors.New("presentation reliable FIFO is full")

// SemanticPresentation is the only replaceable display unit for a v4 session.
// State and frame are published atomically and are always captured from one actor cut.
type SemanticPresentation struct {
	Sequence uint64           `json:"sequence"`
	Geometry TerminalGeometry `json:"geometry"`
	State    TerminalState    `json:"state"`
	Frame    SemanticFrame    `json:"frame"`
}

type TerminalState struct {
	Sequence uint64 `json:"sequence"`
	Title    string `json:"title,omitempty"`
	Bell     uint64 `json:"bell,omitempty"`
}

type SemanticFrame struct {
	Width      int               `json:"width"`
	Height     int               `json:"height"`
	Rows       []SemanticRow     `json:"rows"`
	Cursor     SemanticCursor    `json:"cursor"`
	BufferKind string            `json:"bufferKind"`
	Graphics   []SemanticGraphic `json:"graphics,omitempty"`
}

type SemanticRow struct {
	Cells []SemanticCell `json:"cells"`
}
type SemanticCell struct {
	Text      string        `json:"text"`
	Hyperlink string        `json:"hyperlink,omitempty"`
	Width     uint8         `json:"width"`
	Style     SemanticStyle `json:"style"`
}
type SemanticStyle struct {
	Foreground string `json:"foreground"`
	Background string `json:"background"`
	Bold       bool   `json:"bold,omitempty"`
	Italic     bool   `json:"italic,omitempty"`
	Underline  bool   `json:"underline,omitempty"`
}
type SemanticCursor struct {
	X       int  `json:"x"`
	Y       int  `json:"y"`
	Visible bool `json:"visible"`
}
type SemanticGraphic struct {
	ID         uint64 `json:"id"`
	Generation uint64 `json:"generation"`
	Pixels     []byte `json:"pixels"`
	Row        int    `json:"row"`
	Column     int    `json:"column"`
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
