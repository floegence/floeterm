package terminal

import (
	"errors"
	"fmt"
	"sync"
	"unicode/utf8"
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
	Kind, Text, Code, Action string
	Data                     []byte
	Modifiers                uint16
	Focused                  bool
	X, Y                     float32
}

const (
	SemanticModifierShift uint16 = 1 << iota
	SemanticModifierControl
	SemanticModifierAlt
	SemanticModifierSuper
	SemanticModifierCapsLock
	SemanticModifierNumLock
)

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
	historyEncoder     func(SemanticFrame) ([]byte, string, error)
}

func NewSessionActor(engine SemanticEngine, cols, rows int, store *PresentationStore) (*SessionActor, error) {
	if engine == nil || cols <= 0 || rows <= 0 || store == nil {
		return nil, errors.New("invalid semantic session actor")
	}
	return &SessionActor{
		engine: engine, store: store,
		geometry:       TerminalGeometry{Generation: 1, Cols: cols, Rows: rows},
		historyViews:   make(map[string]semanticHistoryView),
		historyEncoder: encodeSemanticHistoryFrame,
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
	a.releaseAllHistoryLocked()
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
	a.releaseAllHistoryLocked()
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
	if err := validateSemanticInput(intent); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	encoded, err := a.engine.EncodeInput(intent)
	if err != nil {
		return err
	}
	if len(encoded) == 0 {
		return nil
	}
	return write(encoded)
}

func validateSemanticInput(intent SemanticInput) error {
	switch intent.Kind {
	case "bytes":
		if len(intent.Data) == 0 {
			return errors.New("semantic byte input is empty")
		}
	case "text":
		if intent.Text == "" || !utf8.ValidString(intent.Text) {
			return errors.New("semantic text input is empty")
		}
	case "key":
		if intent.Code == "" || !utf8.ValidString(intent.Code) || !utf8.ValidString(intent.Text) ||
			(intent.Action != "press" && intent.Action != "repeat" && intent.Action != "release") {
			return errors.New("semantic key input is invalid")
		}
		const allModifiers = SemanticModifierShift | SemanticModifierControl | SemanticModifierAlt | SemanticModifierSuper | SemanticModifierCapsLock | SemanticModifierNumLock
		if intent.Modifiers & ^allModifiers != 0 {
			return errors.New("semantic key modifiers are invalid")
		}
	default:
		return errors.New("semantic input kind is invalid")
	}
	return nil
}

func (a *SessionActor) ReadHistory(request SemanticHistoryRequest) (SemanticHistoryChunk, error) {
	if err := validateSemanticHistoryRequest(request); err != nil {
		return SemanticHistoryChunk{}, err
	}
	request.Lane = normalizeSemanticHistoryLane(request.Lane)
	a.mu.Lock()
	engine, ok := a.engine.(SemanticHistoryEngine)
	if !ok {
		a.mu.Unlock()
		return SemanticHistoryChunk{}, errors.New("semantic history is unavailable")
	}
	if request.Continuation != "" {
		view, exists := a.historyViews[request.ViewID]
		if !exists || len(view.snapshot.payload) == 0 {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
		}
		chunkIndex, valid := semanticHistoryContinuationIndex(view.snapshot.id, request.Continuation)
		if !valid || chunkIndex != view.snapshot.nextChunkIndex {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
		}
		chunk, err := semanticHistoryChunk(view.snapshot, chunkIndex)
		if err != nil {
			a.releaseHistoryViewLocked(request.ViewID)
		} else if chunk.Continuation == "" {
			view.snapshot.payload = nil
			view.snapshot.payloadSHA256 = ""
			view.snapshot.nextChunkIndex = 0
			a.historyViews[request.ViewID] = view
		} else {
			view.snapshot.nextChunkIndex++
			a.historyViews[request.ViewID] = view
		}
		a.mu.Unlock()
		return chunk, err
	}
	if request.ViewportRows != a.geometry.Rows {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		return SemanticHistoryChunk{}, errors.New("semantic history viewport must match canonical geometry")
	}

	totalRows, err := engine.HistoryTotalRows()
	if err != nil {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		return SemanticHistoryChunk{}, err
	}
	if totalRows < request.ViewportRows {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		return SemanticHistoryChunk{}, errors.New("semantic history cannot fill the canonical viewport")
	}
	maxStart := max(0, totalRows-request.ViewportRows)
	targetRow := 0
	view, exists := a.historyViews[request.ViewID]
	switch request.Direction {
	case HistoryStart:
		targetRow = 0
	case HistoryEnd:
		targetRow = maxStart
	case HistoryForward, HistoryBackward:
		if !exists || request.Anchor != view.anchorID || request.SnapshotID != view.snapshot.id || request.Offset != view.snapshot.offset {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
		}
		if view.snapshot.contentEpoch != a.contentEpoch ||
			view.snapshot.geometryGeneration != a.geometry.Generation {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, ErrSemanticHistorySuperseded
		}
		firstRow, status, rowErr := engine.HistoryAnchorScreenRow(view.firstAvailable)
		if rowErr != nil {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, rowErr
		}
		if status != AnchorValid || firstRow != 0 {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
		}
		if request.TargetOffset != nil {
			targetRow = min(maxStart, max(0, *request.TargetOffset))
			if targetRow == request.Offset ||
				(request.Direction == HistoryForward && targetRow < request.Offset) ||
				(request.Direction == HistoryBackward && targetRow > request.Offset) {
				a.releaseHistoryViewLocked(request.ViewID)
				a.mu.Unlock()
				return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
			}
		} else if request.Direction == HistoryForward {
			targetRow = min(maxStart, request.Offset+request.ScrollDeltaRows)
		} else {
			targetRow = max(0, request.Offset-request.ScrollDeltaRows)
		}
	}

	if !exists || request.Direction == HistoryStart || request.Direction == HistoryEnd {
		created, createErr := a.createSemanticHistoryViewLocked(engine)
		if createErr != nil {
			a.releaseHistoryViewLocked(request.ViewID)
			a.mu.Unlock()
			return SemanticHistoryChunk{}, createErr
		}
		if exists {
			view.close()
		}
		view = created
	}
	view.requestEpoch++
	view.snapshot.payload = nil
	a.historyViews[request.ViewID] = view
	reservation := view.requestEpoch

	target, err := engine.TrackHistoryCell(0, targetRow)
	if err != nil {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		return SemanticHistoryChunk{}, err
	}
	frame, status, err := engine.ReadHistory(target, request.ViewportRows)
	target.Close()
	if err != nil || status != AnchorValid {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		if err != nil {
			return SemanticHistoryChunk{}, err
		}
		return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
	}
	if frame.Width != a.geometry.Cols || frame.Height != a.geometry.Rows || len(frame.Rows) != a.geometry.Rows {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		return SemanticHistoryChunk{}, errors.New("semantic history viewport geometry is invalid")
	}
	screenStartOffset := max(0, totalRows-a.geometry.Rows)
	frame.History = SemanticHistorySummary{
		Revision: a.sequence, TotalRows: totalRows,
		ScreenStartOffset: screenStartOffset,
	}
	a.nextHistoryTokenID++
	snapshot := semanticHistorySnapshot{
		id: fmt.Sprintf("hs-%x", a.nextHistoryTokenID), lane: request.Lane,
		revision: a.sequence, contentEpoch: a.contentEpoch,
		geometryGeneration: a.geometry.Generation, cols: a.geometry.Cols, rows: a.geometry.Rows,
		offset: targetRow, totalRows: totalRows, screenStartOffset: screenStartOffset,
		hasPrevious: targetRow > 0, hasNext: targetRow < maxStart,
		anchor: view.anchorID, firstAvailable: view.firstAvailableID,
		lastAvailable: view.lastAvailableID, screenStart: view.screenStartID,
	}
	encoder := a.historyEncoder
	a.mu.Unlock()

	payload, payloadSHA256, err := encoder(frame)
	if err != nil {
		a.mu.Lock()
		if current, exists := a.historyViews[request.ViewID]; exists && current.requestEpoch == reservation && current.anchorID == view.anchorID {
			a.releaseHistoryViewLocked(request.ViewID)
		}
		a.mu.Unlock()
		return SemanticHistoryChunk{}, err
	}

	a.mu.Lock()
	current, exists := a.historyViews[request.ViewID]
	if !exists || current.requestEpoch != reservation || current.anchorID != view.anchorID ||
		a.contentEpoch != snapshot.contentEpoch ||
		a.geometry.Generation != snapshot.geometryGeneration ||
		a.geometry.Cols != snapshot.cols || a.geometry.Rows != snapshot.rows {
		a.mu.Unlock()
		return SemanticHistoryChunk{}, ErrSemanticHistorySuperseded
	}
	firstRow, status, rowErr := engine.HistoryAnchorScreenRow(current.firstAvailable)
	if rowErr != nil || status != AnchorValid || firstRow != 0 {
		a.releaseHistoryViewLocked(request.ViewID)
		a.mu.Unlock()
		if rowErr != nil {
			return SemanticHistoryChunk{}, rowErr
		}
		return SemanticHistoryChunk{}, ErrSemanticHistoryAnchor
	}
	snapshot.payload = payload
	snapshot.payloadSHA256 = payloadSHA256
	current.snapshot = snapshot
	chunk, err := semanticHistoryChunk(snapshot, 0)
	if err != nil {
		a.releaseHistoryViewLocked(request.ViewID)
	} else if chunk.Continuation == "" {
		current.snapshot.payload = nil
		current.snapshot.payloadSHA256 = ""
	} else {
		current.snapshot.nextChunkIndex = 1
	}
	if err == nil {
		a.historyViews[request.ViewID] = current
	}
	a.mu.Unlock()
	return chunk, err
}

func (a *SessionActor) createSemanticHistoryViewLocked(engine SemanticHistoryEngine) (semanticHistoryView, error) {
	anchor, err := engine.TrackHistoryCell(0, 0)
	if err != nil {
		return semanticHistoryView{}, err
	}
	nextID := func(prefix string) string {
		a.nextHistoryTokenID++
		return fmt.Sprintf("%s-%x", prefix, a.nextHistoryTokenID)
	}
	return semanticHistoryView{
		anchorID:         nextID("ha"),
		firstAvailableID: nextID("hf"), lastAvailableID: nextID("hl"), screenStartID: nextID("hs"),
		firstAvailable: anchor,
	}, nil
}

func (a *SessionActor) releaseHistoryViewLocked(viewID string) {
	if viewID == "" {
		return
	}
	if view, ok := a.historyViews[viewID]; ok {
		view.close()
		delete(a.historyViews, viewID)
	}
}

func (a *SessionActor) releaseAllHistoryLocked() {
	for viewID, view := range a.historyViews {
		view.close()
		delete(a.historyViews, viewID)
	}
}

func (a *SessionActor) ReleaseHistory(viewID string) {
	if a == nil || viewID == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.releaseHistoryViewLocked(viewID)
}

func (a *SessionActor) Close() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.releaseAllHistoryLocked()
	if a.engine != nil {
		a.engine.Close()
		a.engine = nil
	}
	if a.store != nil {
		a.store.Close()
	}
}
