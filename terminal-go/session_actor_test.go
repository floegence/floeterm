package terminal

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

type fakeSemanticEngine struct {
	output     []byte
	frame      SemanticFrame
	calls      []string
	captureErr error
	resizeErr  error
}

type fakeHistoryAnchor struct {
	row    int
	closed bool
}

func (a *fakeHistoryAnchor) Close() { a.closed = true }

type fakeSemanticHistoryEngine struct {
	fakeSemanticEngine
	totalRows int
	anchors   []*fakeHistoryAnchor
}

func (e *fakeSemanticHistoryEngine) TrackHistoryCell(_ int, row int) (SemanticHistoryAnchor, error) {
	e.calls = append(e.calls, "history-track")
	if row < 0 || row >= e.totalRows {
		return nil, errors.New("history row outside retained screen")
	}
	anchor := &fakeHistoryAnchor{row: row}
	e.anchors = append(e.anchors, anchor)
	return anchor, nil
}

func (e *fakeSemanticHistoryEngine) HistoryAnchorScreenRow(anchor SemanticHistoryAnchor) (int, AnchorStatus, error) {
	e.calls = append(e.calls, "history-anchor-row")
	tracked, ok := anchor.(*fakeHistoryAnchor)
	if !ok || tracked.closed {
		return 0, AnchorInvalid, nil
	}
	return tracked.row, AnchorValid, nil
}

func (e *fakeSemanticHistoryEngine) HistoryTotalRows() (int, error) {
	e.calls = append(e.calls, "history-total")
	return e.totalRows, nil
}

func (e *fakeSemanticHistoryEngine) ReadHistory(anchor SemanticHistoryAnchor, limit int) (SemanticFrame, AnchorStatus, error) {
	e.calls = append(e.calls, "history-read")
	tracked, ok := anchor.(*fakeHistoryAnchor)
	if !ok || tracked.closed {
		return SemanticFrame{}, AnchorInvalid, nil
	}
	height := min(limit, e.totalRows-tracked.row)
	frame := SemanticFrame{Width: 8, Height: height, BufferKind: "normal", Rows: make([]SemanticRow, height)}
	for row := range frame.Rows {
		frame.Rows[row].Cells = []SemanticCell{{Text: fmt.Sprintf("row-%d", tracked.row+row), Width: 1}}
	}
	return frame, AnchorValid, nil
}

func (e *fakeSemanticEngine) ApplyOutput(data []byte) (TerminalState, error) {
	e.calls = append(e.calls, "apply")
	e.output = append(e.output, data...)
	return TerminalState{Title: "shell"}, nil
}
func (e *fakeSemanticEngine) CaptureFrame() (SemanticFrame, error) {
	e.calls = append(e.calls, "capture")
	if e.captureErr != nil {
		err := e.captureErr
		e.captureErr = nil
		return SemanticFrame{}, err
	}
	return e.frame, nil
}
func (e *fakeSemanticEngine) Resize(c, r int) error {
	e.calls = append(e.calls, "resize")
	if e.resizeErr != nil {
		return e.resizeErr
	}
	e.frame.Width, e.frame.Height = c, r
	return nil
}
func (e *fakeSemanticEngine) EncodeInput(i SemanticInput) ([]byte, error) {
	e.calls = append(e.calls, "input")
	if i.Text == "" {
		return nil, errors.New("empty")
	}
	return []byte(i.Text), nil
}
func (e *fakeSemanticEngine) Close() { e.calls = append(e.calls, "close") }

func TestSessionActorAppliesOutputBeforeCapturingAtomicPresentation(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24, Rows: []SemanticRow{{Cells: []SemanticCell{{Text: "界"}}}}}}
	store := NewPresentationStore(2)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.ApplyPTYOutput([]byte("bytes")); err != nil {
		t.Fatal(err)
	}
	if len(engine.calls) != 2 || engine.calls[0] != "apply" || engine.calls[1] != "capture" {
		t.Fatalf("calls=%v", engine.calls)
	}
	p, ok := store.Latest()
	if !ok || p.Sequence != 1 || p.State.Sequence != 1 || p.Geometry.Cols != 80 || p.Frame.Rows[0].Cells[0].Text != "界" {
		t.Fatalf("presentation=%+v", p)
	}
}

func TestSessionActorSerializesResizeAndInputIntent(t *testing.T) {
	engine := &fakeSemanticEngine{}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(1))
	if err := actor.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	var wrote string
	if err := actor.Input(SemanticInput{Kind: "text", Text: "x"}, func(data []byte) error { wrote = string(data); return nil }); err != nil {
		t.Fatal(err)
	}
	if wrote != "x" || len(engine.calls) != 3 || engine.calls[0] != "resize" || engine.calls[1] != "capture" || engine.calls[2] != "input" {
		t.Fatalf("calls=%v wrote=%q", engine.calls, wrote)
	}
}

func TestSessionActorOwnsConcurrentAdmissionSequence(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(64))
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := actor.ApplyPTYOutput([]byte("x")); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(engine.output) != 20 {
		t.Fatalf("output bytes=%d", len(engine.output))
	}
}

func TestSessionActorResizePresentationDoesNotBackpressureLatestSlot(t *testing.T) {
	engine := &fakeSemanticEngine{}
	store := NewPresentationStore(2)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	for index := 1; index <= 100; index++ {
		cols, rows := 80+index%17, 24+index%11
		engine.frame = SemanticFrame{Width: cols, Height: rows}
		geometry := TerminalGeometry{Generation: uint64(index + 1), Cols: cols, Rows: rows}
		if _, err := actor.ResizeToGeometryAndCapture(geometry); err != nil {
			t.Fatalf("resize %d backpressured latest Presentation: %v", index, err)
		}
	}
	latest, ok := store.Latest()
	if !ok || latest.Sequence != 100 || latest.Geometry.Generation != 101 {
		t.Fatalf("latest Presentation=%+v ok=%v", latest, ok)
	}
}

func TestSessionActorRollsBackGeometryWhenResizeCaptureFails(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	store := NewPresentationStore(1)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	before, _ := store.Latest()
	engine.captureErr = errors.New("capture failed")
	if _, err := actor.ResizeToGeometryAndCapture(TerminalGeometry{Generation: 2, Cols: 120, Rows: 40}); err == nil || !strings.Contains(err.Error(), "capture failed") {
		t.Fatalf("resize error=%v, want capture failure", err)
	}
	after, _ := store.Latest()
	if engine.frame.Width != 80 || engine.frame.Height != 24 {
		t.Fatalf("engine geometry=%dx%d, want rollback to 80x24", engine.frame.Width, engine.frame.Height)
	}
	if after.Sequence != before.Sequence || after.Geometry != before.Geometry {
		t.Fatalf("failed resize published Presentation: before=%+v after=%+v", before, after)
	}
	if len(engine.calls) < 3 || engine.calls[len(engine.calls)-3] != "resize" || engine.calls[len(engine.calls)-2] != "capture" || engine.calls[len(engine.calls)-1] != "resize" {
		t.Fatalf("resize/capture/rollback calls=%v", engine.calls)
	}
}

func TestSessionActorReadsOwnedSemanticHistoryWithoutMovingPresentation(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 12}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	store := NewPresentationStore(1)
	actor, err := NewSessionActor(engine, 8, 3, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.ApplyPTYOutput([]byte("live")); err != nil {
		t.Fatal(err)
	}
	before, _ := store.Latest()

	page, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Direction: HistoryStart, Limit: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Revision != before.Sequence || page.Frame.Height != 5 || page.Frame.Rows[0].Cells[0].Text != "row-0" {
		t.Fatalf("history page=%+v", page)
	}
	if page.Anchor == "" || page.FirstAvailable == "" || page.LastAvailable == "" || page.ScreenStart == "" {
		t.Fatalf("history anchors are not opaque and complete: %+v", page)
	}
	if page.HasPrevious || !page.HasNext {
		t.Fatalf("history bounds=%+v", page)
	}
	page.Frame.Rows[0].Cells[0].Text = "mutated"
	after, _ := store.Latest()
	if after.Sequence != before.Sequence || after.Frame.Width != before.Frame.Width {
		t.Fatalf("readonly history changed latest Presentation: before=%+v after=%+v", before, after)
	}

	next, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Anchor: page.Anchor, Direction: HistoryForward, Limit: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Frame.Rows[0].Cells[0].Text != "row-5" || !next.HasPrevious || !next.HasNext {
		t.Fatalf("next history page=%+v", next)
	}
	if got := strings.Join(engine.calls[len(engine.calls)-7:], ","); got != "history-total,history-anchor-row,history-track,history-track,history-track,history-track,history-read" {
		t.Fatalf("history actor order=%v", engine.calls)
	}
}

func TestSessionActorReleasesSupersededHistoryAnchorsAndRejectsStaleTokens(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 9}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	first, err := actor.ReadHistory(SemanticHistoryRequest{ViewID: "view-a", Direction: HistoryEnd, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	firstAnchors := append([]*fakeHistoryAnchor(nil), engine.anchors...)
	second, err := actor.ReadHistory(SemanticHistoryRequest{ViewID: "view-a", Anchor: first.Anchor, Direction: HistoryBackward, Limit: 3})
	if err != nil {
		t.Fatal(err)
	}
	if second.Frame.Rows[0].Cells[0].Text != "row-3" {
		t.Fatalf("backward history page=%+v", second)
	}
	for _, anchor := range firstAnchors {
		if !anchor.closed {
			t.Fatal("superseded server-owned history anchor was not released")
		}
	}
	if _, err := actor.ReadHistory(SemanticHistoryRequest{ViewID: "view-a", Anchor: first.Anchor, Direction: HistoryForward, Limit: 3}); !errors.Is(err, ErrSemanticHistoryAnchor) {
		t.Fatalf("stale anchor error=%v", err)
	}
	actor.ReleaseHistory("view-a")
	for _, anchor := range engine.anchors {
		if !anchor.closed {
			t.Fatal("released view retained a native history anchor")
		}
	}
}

func TestSessionActorBoundsSemanticHistoryRequests(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: MaxSemanticHistoryRows + 1}
	actor, _ := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	for _, request := range []SemanticHistoryRequest{
		{ViewID: "", Direction: HistoryStart, Limit: 1},
		{ViewID: "view", Direction: "sideways", Limit: 1},
		{ViewID: "view", Direction: HistoryStart, Limit: 0},
		{ViewID: "view", Direction: HistoryStart, Limit: MaxSemanticHistoryRows + 1},
	} {
		if _, err := actor.ReadHistory(request); err == nil {
			t.Fatalf("request %+v unexpectedly succeeded", request)
		}
	}
}
