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
	mu                 sync.Mutex
	engine             SemanticEngine
	store              *PresentationStore
	geometry           TerminalGeometry
	sequence           uint64
	historyViews       map[string]semanticHistoryView
	nextHistoryTokenID uint64
}

func NewSessionActor(engine SemanticEngine, cols, rows int, store *PresentationStore) (*SessionActor, error) {
	if engine == nil || cols <= 0 || rows <= 0 || store == nil {
		return nil, errors.New("invalid semantic session actor")
	}
	return &SessionActor{
		engine: engine, store: store,
		geometry:     TerminalGeometry{Generation: 1, Cols: cols, Rows: rows},
		historyViews: make(map[string]semanticHistoryView),
	}, nil
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
	frame.History.Revision = a.sequence
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
	frame.History.Revision = a.sequence
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
	frame.History.Revision = a.sequence + 1
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

func (a *SessionActor) ReadHistory(request SemanticHistoryRequest) (SemanticHistoryPage, error) {
	if err := validateSemanticHistoryRequest(request); err != nil {
		return SemanticHistoryPage{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	engine, ok := a.engine.(SemanticHistoryEngine)
	if !ok {
		return SemanticHistoryPage{}, errors.New("semantic history is unavailable")
	}
	if request.ExpectedRevision != 0 && request.ExpectedRevision != a.sequence {
		return SemanticHistoryPage{}, ErrSemanticHistoryRevision
	}
	totalRows, err := engine.HistoryTotalRows()
	if err != nil {
		return SemanticHistoryPage{}, err
	}
	if totalRows <= 0 {
		return SemanticHistoryPage{}, errors.New("semantic history is empty")
	}
	maxStart := max(0, totalRows-request.Limit)
	targetRow := 0
	switch request.Direction {
	case HistoryEnd:
		targetRow = maxStart
	case HistoryForward, HistoryBackward:
		view, exists := a.historyViews[request.ViewID]
		anchor := view.tokens[request.Anchor]
		if !exists || anchor == nil {
			return SemanticHistoryPage{}, ErrSemanticHistoryAnchor
		}
		row, status, rowErr := engine.HistoryAnchorScreenRow(anchor)
		if rowErr != nil {
			return SemanticHistoryPage{}, rowErr
		}
		if status != AnchorValid {
			return SemanticHistoryPage{}, ErrSemanticHistoryAnchor
		}
		if request.Direction == HistoryForward {
			targetRow = min(maxStart, row+request.Limit)
		} else {
			targetRow = max(0, row-request.Limit)
		}
	}

	rows := []int{targetRow, 0, totalRows - 1, max(0, totalRows-a.geometry.Rows)}
	tokens := make(map[string]SemanticHistoryAnchor, len(rows))
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		anchor, trackErr := engine.TrackHistoryCell(0, row)
		if trackErr != nil {
			closeSemanticHistoryTokens(tokens)
			return SemanticHistoryPage{}, trackErr
		}
		a.nextHistoryTokenID++
		token := fmt.Sprintf("h-%x", a.nextHistoryTokenID)
		tokens[token] = anchor
		ids = append(ids, token)
	}
	frame, status, err := engine.ReadHistory(tokens[ids[0]], request.Limit)
	if err != nil || status != AnchorValid {
		closeSemanticHistoryTokens(tokens)
		if err != nil {
			return SemanticHistoryPage{}, err
		}
		return SemanticHistoryPage{}, ErrSemanticHistoryAnchor
	}
	if frame.Width != a.geometry.Cols || frame.Height <= 0 || frame.Height > request.Limit {
		closeSemanticHistoryTokens(tokens)
		return SemanticHistoryPage{}, errors.New("semantic history page geometry is invalid")
	}
	frame.History = SemanticHistorySummary{
		Revision: a.sequence, TotalRows: totalRows,
		ScreenStartOffset: max(0, totalRows-a.geometry.Rows),
	}
	if previous, exists := a.historyViews[request.ViewID]; exists {
		closeSemanticHistoryTokens(previous.tokens)
	}
	a.historyViews[request.ViewID] = semanticHistoryView{tokens: tokens}
	return SemanticHistoryPage{
		Revision: a.sequence, Anchor: ids[0], FirstAvailable: ids[1], LastAvailable: ids[2], ScreenStart: ids[3],
		Offset: targetRow, TotalRows: totalRows, ScreenStartOffset: rows[3],
		HasPrevious: targetRow > 0, HasNext: targetRow < maxStart, Frame: frame,
	}, nil
}

func (a *SessionActor) ReleaseHistory(viewID string) {
	if a == nil || viewID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if view, ok := a.historyViews[viewID]; ok {
		closeSemanticHistoryTokens(view.tokens)
		delete(a.historyViews, viewID)
	}
}

func (a *SessionActor) Close() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for viewID, view := range a.historyViews {
		closeSemanticHistoryTokens(view.tokens)
		delete(a.historyViews, viewID)
	}
	if a.engine != nil {
		a.engine.Close()
		a.engine = nil
	}
	if a.store != nil {
		a.store.Close()
	}
}
