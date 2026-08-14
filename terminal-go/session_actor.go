package terminal

import (
	"errors"
	"fmt"
	"sync"
)

var ErrSemanticClearUnavailable = errors.New("semantic terminal clear is unavailable")

type SemanticEngine interface {
	ApplyOutput([]byte) (TerminalState, error)
	CaptureFrame() (SemanticFrame, error)
	Resize(cols, rows int) error
	EncodeInput(SemanticInput) ([]byte, error)
	Close()
}

// SemanticResetEngine is implemented by engines that can atomically reset
// their screen, scrollback, graphics, and terminal modes inside the actor.
// Keeping this optional avoids turning a native-only control into a second VT
// implementation requirement for metadata-only consumers.
type SemanticResetEngine interface {
	Reset() error
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
	contentEpoch       uint64
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
	a.geometry.PresentationSequence = a.sequence
	return a.store.Publish(SemanticPresentation{Sequence: 1, Geometry: a.geometry, State: TerminalState{Sequence: 1, ContentEpoch: a.contentEpoch}, Frame: frame})
}

func (a *SessionActor) ApplyPTYOutput(data []byte) (SemanticPresentation, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	state, err := a.engine.ApplyOutput(data)
	if err != nil {
		return SemanticPresentation{}, err
	}
	frame, err := a.engine.CaptureFrame()
	if err != nil {
		return SemanticPresentation{}, err
	}
	a.sequence++
	frame.History.Revision = a.sequence
	state.Sequence = a.sequence
	state.ContentEpoch = a.contentEpoch
	geometry := a.geometry
	geometry.PresentationSequence = a.sequence
	p := SemanticPresentation{Sequence: a.sequence, Geometry: geometry, State: state, Frame: frame}
	if err := a.store.Publish(p); err != nil {
		return SemanticPresentation{}, err
	}
	a.geometry = geometry
	return p, nil
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
	nextSequence := a.sequence + 1
	geometry.PresentationSequence = nextSequence
	frame.History.Revision = nextSequence
	presentation := SemanticPresentation{Sequence: nextSequence, Geometry: geometry, State: TerminalState{Sequence: nextSequence, ContentEpoch: a.contentEpoch}, Frame: frame}
	if err := a.store.Publish(presentation); err != nil {
		return SemanticPresentation{}, a.rollbackResizeLocked(previousGeometry, err)
	}
	a.geometry = geometry
	a.sequence++
	return presentation, nil
}

// Clear resets all engine-owned terminal content and publishes the resulting
// blank state as one actor cut. Native history anchors are invalid after the
// reset, so every view projection is released before the new epoch is visible.
func (a *SessionActor) Clear() (SemanticPresentation, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	engine, ok := a.engine.(SemanticResetEngine)
	if !ok {
		return SemanticPresentation{}, ErrSemanticClearUnavailable
	}
	if err := engine.Reset(); err != nil {
		return SemanticPresentation{}, fmt.Errorf("reset semantic terminal: %w", err)
	}
	for viewID, view := range a.historyViews {
		closeSemanticHistoryTokens(view.tokens)
		delete(a.historyViews, viewID)
	}
	frame, err := a.engine.CaptureFrame()
	if err != nil {
		return SemanticPresentation{}, fmt.Errorf("capture cleared semantic terminal: %w", err)
	}
	if frame.Width != a.geometry.Cols || frame.Height != a.geometry.Rows {
		return SemanticPresentation{}, fmt.Errorf(
			"cleared semantic frame geometry %dx%d does not match canonical geometry %dx%d",
			frame.Width, frame.Height, a.geometry.Cols, a.geometry.Rows,
		)
	}
	nextSequence := a.sequence + 1
	nextEpoch := a.contentEpoch + 1
	geometry := a.geometry
	geometry.PresentationSequence = nextSequence
	frame.History.Revision = nextSequence
	presentation := SemanticPresentation{
		Sequence: nextSequence,
		Geometry: geometry,
		State:    TerminalState{Sequence: nextSequence, ContentEpoch: nextEpoch},
		Frame:    frame,
	}
	if err := a.store.Publish(presentation); err != nil {
		return SemanticPresentation{}, err
	}
	a.sequence = nextSequence
	a.contentEpoch = nextEpoch
	a.geometry = geometry
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
