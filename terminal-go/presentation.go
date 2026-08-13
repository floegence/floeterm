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
	graphics := p.Frame.Graphics
	if graphics.Images == nil {
		graphics.Images = []SemanticGraphicImage{}
	}
	if graphics.Placements == nil {
		graphics.Placements = []SemanticGraphicPlacement{}
	}
	wire := map[string]any{
		"v": 1, "sequence": p.Sequence, "geometry": p.Geometry, "state": p.State,
		"frame": map[string]any{"width": p.Frame.Width, "height": p.Frame.Height, "bufferKind": p.Frame.BufferKind, "cursor": p.Frame.Cursor, "history": p.Frame.History, "graphics": graphics, "styles": styles, "rows": rows},
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
	Width      int                    `json:"width"`
	Height     int                    `json:"height"`
	Rows       []SemanticRow          `json:"rows"`
	Cursor     SemanticCursor         `json:"cursor"`
	BufferKind string                 `json:"bufferKind"`
	History    SemanticHistorySummary `json:"history"`
	Graphics   SemanticGraphics       `json:"graphics"`
}

// SemanticHistorySummary is captured from the same engine ownership window as
// the frame. It gives views bounded rail geometry without exposing row IDs or
// native anchors; page content still requires an attachment-bound opaque token.
type SemanticHistorySummary struct {
	Revision          uint64 `json:"revision"`
	TotalRows         int    `json:"totalRows"`
	ScreenStartOffset int    `json:"screenStartOffset"`
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
type SemanticGraphicFormat uint8

const (
	SemanticGraphicRGB SemanticGraphicFormat = iota
	SemanticGraphicRGBA
	semanticGraphicPNG
	SemanticGraphicGrayAlpha
	SemanticGraphicGray
)

type SemanticGraphicImage struct {
	ID         uint32                `json:"id"`
	Width      uint32                `json:"width"`
	Height     uint32                `json:"height"`
	Format     SemanticGraphicFormat `json:"format"`
	Generation uint64                `json:"generation"`
	Pixels     []byte                `json:"pixels"`
}

type SemanticGraphicPlacement struct {
	ImageID        uint32 `json:"imageId"`
	PlacementID    uint32 `json:"placementId"`
	Z              int32  `json:"z"`
	ViewportColumn int32  `json:"viewportColumn"`
	ViewportRow    int32  `json:"viewportRow"`
	GridColumns    uint32 `json:"gridColumns"`
	GridRows       uint32 `json:"gridRows"`
	Visible        bool   `json:"visible"`
	Virtual        bool   `json:"virtual"`
}

type SemanticGraphics struct {
	Generation uint64                     `json:"generation"`
	Images     []SemanticGraphicImage     `json:"images"`
	Placements []SemanticGraphicPlacement `json:"placements"`
}

func clonePresentation(in SemanticPresentation) SemanticPresentation {
	out := in
	out.Frame.Rows = append([]SemanticRow(nil), in.Frame.Rows...)
	for i := range out.Frame.Rows {
		out.Frame.Rows[i].Cells = append([]SemanticCell(nil), in.Frame.Rows[i].Cells...)
	}
	out.Frame.Graphics.Images = append([]SemanticGraphicImage(nil), in.Frame.Graphics.Images...)
	for i := range out.Frame.Graphics.Images {
		out.Frame.Graphics.Images[i].Pixels = append([]byte(nil), in.Frame.Graphics.Images[i].Pixels...)
	}
	out.Frame.Graphics.Placements = append([]SemanticGraphicPlacement(nil), in.Frame.Graphics.Placements...)
	return out
}

// PresentationStore owns one replaceable pending Presentation. A full frame is
// self-contained, so retaining older frames would only backpressure the actor
// and can never improve what a view eventually renders.
type PresentationStore struct {
	mu      sync.Mutex
	latest  SemanticPresentation
	pending bool
	closed  bool
}

func NewPresentationStore(_ int) *PresentationStore {
	return &PresentationStore{}
}

func (s *PresentationStore) Publish(p SemanticPresentation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errSessionClosed
	}
	s.latest = clonePresentation(p)
	s.pending = true
	return nil
}

func (s *PresentationStore) Next() (SemanticPresentation, bool) {
	return s.TakeLatest()
}

// TakeLatest returns the newest immutable presentation and advances the
// delivery cursor past older frames. Live views render a complete snapshot,
// so replaying every intermediate frame would let a slow transport stall the
// PTY actor without improving what the user sees.
func (s *PresentationStore) TakeLatest() (SemanticPresentation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.pending {
		return SemanticPresentation{}, false
	}
	p := clonePresentation(s.latest)
	s.pending = false
	return p, true
}

func (s *PresentationStore) Latest() (SemanticPresentation, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.latest.Sequence == 0 {
		return SemanticPresentation{}, false
	}
	return clonePresentation(s.latest), true
}

func (s *PresentationStore) Close() { s.mu.Lock(); s.closed = true; s.pending = false; s.mu.Unlock() }

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
