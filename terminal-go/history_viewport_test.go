package terminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestSessionActorHistorySnapshotKeepsFullViewportAcrossTransportChunks(t *testing.T) {
	const cols = 103
	const rows = 37
	engine := &fakeSemanticHistoryEngine{totalRows: 100}
	engine.frame = SemanticFrame{Width: cols, Height: rows}
	actor, err := NewSessionActor(engine, cols, rows, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("live")); err != nil {
		t.Fatal(err)
	}

	chunk, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Direction: HistoryEnd, ViewportRows: rows,
	})
	if err != nil {
		t.Fatal(err)
	}
	chunks := []SemanticHistoryChunk{chunk}
	for chunk.Continuation != "" {
		chunk, err = actor.ReadHistory(SemanticHistoryRequest{
			ViewID: "view-a", Continuation: chunk.Continuation,
		})
		if err != nil {
			t.Fatal(err)
		}
		chunks = append(chunks, chunk)
	}
	if len(chunks) < 2 {
		t.Fatalf("history snapshot chunks=%d, want continuation", len(chunks))
	}
	var encoded bytes.Buffer
	for index, item := range chunks {
		if item.SnapshotID != chunks[0].SnapshotID || item.ChunkIndex != index || item.Rows != rows || item.Cols != cols {
			t.Fatalf("history chunk %d identity=%+v", index, item)
		}
		encoded.Write(item.Payload)
		wireBytes, marshalErr := json.Marshal(item)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if len(wireBytes) >= 96*1024 {
			t.Fatalf("history transport chunk bytes=%d, want below 96KiB", len(wireBytes))
		}
	}
	var wire struct {
		Frame struct {
			Width  int       `json:"width"`
			Height int       `json:"height"`
			Rows   [][][]any `json:"rows"`
		} `json:"frame"`
	}
	if err := json.Unmarshal(encoded.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Frame.Width != cols || wire.Frame.Height != rows || len(wire.Frame.Rows) != rows {
		t.Fatalf("history viewport geometry=%dx%d rows=%d", wire.Frame.Width, wire.Frame.Height, len(wire.Frame.Rows))
	}
	for row := range wire.Frame.Rows {
		want := fmt.Sprintf("row-%d", chunks[0].Offset+row)
		if got := wire.Frame.Rows[row][0][0]; got != want {
			t.Fatalf("history row %d=%v, want %q", row, got, want)
		}
	}
	actor.mu.Lock()
	view := actor.historyViews["view-a"]
	actor.mu.Unlock()
	if len(view.snapshot.payload) != 0 {
		t.Fatal("completed multi-chunk history response retained encoded payload")
	}
}

func TestSessionActorHistoryContinuationKeepsItsImmutableCutAcrossLiveOutput(t *testing.T) {
	const cols = 103
	const rows = 37
	engine := &fakeSemanticHistoryEngine{totalRows: 100}
	engine.frame = SemanticFrame{Width: cols, Height: rows}
	actor, err := NewSessionActor(engine, cols, rows, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	first, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Direction: HistoryEnd, ViewportRows: rows,
	})
	if err != nil || first.Continuation == "" {
		t.Fatalf("first history chunk=%+v error=%v", first, err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("new live output")); err != nil {
		t.Fatal(err)
	}
	next, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Continuation: first.Continuation,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.SnapshotID != first.SnapshotID || next.Revision != first.Revision || next.Offset != first.Offset {
		t.Fatalf("continuation changed immutable history cut: first=%+v next=%+v", first, next)
	}
	if _, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Direction: HistoryStart, ViewportRows: rows,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Continuation: first.Continuation,
	}); !errors.Is(err, ErrSemanticHistoryAnchor) {
		t.Fatalf("superseded continuation error=%v", err)
	}
}

func TestSessionActorRejectsSkippedOrRepeatedContinuationAndReleasesView(t *testing.T) {
	const cols = 103
	const rows = 37
	engine := &fakeSemanticHistoryEngine{totalRows: 100}
	engine.frame = SemanticFrame{Width: cols, Height: rows}
	actor, err := NewSessionActor(engine, cols, rows, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	first, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/continuation", Direction: HistoryEnd, ViewportRows: rows,
	})
	if err != nil || first.Continuation == "" {
		t.Fatalf("first history chunk=%+v error=%v", first, err)
	}
	if _, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/continuation", Continuation: semanticHistoryContinuation(first.SnapshotID, 2),
	}); !errors.Is(err, ErrSemanticHistoryAnchor) {
		t.Fatalf("skipped continuation error=%v", err)
	}
	actor.mu.Lock()
	_, retained := actor.historyViews["view/continuation"]
	actor.mu.Unlock()
	if retained {
		t.Fatal("skipped continuation retained history view")
	}
	for _, anchor := range engine.anchors {
		if !anchor.closed || anchor.closeCount != 1 {
			t.Fatalf("skipped continuation anchor state=%+v", anchor)
		}
	}
}

func TestSessionActorHistoryFrontierSurvivesLiveSequenceAndRejectsStaleSnapshotFence(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 12}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(2))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("first")); err != nil {
		t.Fatal(err)
	}
	first, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/live", Direction: HistoryEnd, ViewportRows: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("second")); err != nil {
		t.Fatal(err)
	}
	target := first.Offset - 1
	second, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/live", Anchor: first.Anchor, SnapshotID: first.SnapshotID,
		Direction: HistoryBackward, Offset: first.Offset, TargetOffset: &target, ViewportRows: 3,
	})
	if err != nil {
		t.Fatalf("live output invalidated a retained frontier: %v", err)
	}
	if second.Revision <= first.Revision || second.Anchor != first.Anchor {
		t.Fatalf("history lineage/revision first=%+v second=%+v", first, second)
	}
	if _, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/live", Anchor: first.Anchor, SnapshotID: first.SnapshotID,
		Direction: HistoryBackward, Offset: first.Offset, TargetOffset: &target, ViewportRows: 3,
	}); !errors.Is(err, ErrSemanticHistoryAnchor) {
		t.Fatalf("stale snapshot fence error=%v", err)
	}
}

func TestSessionActorReleasesCompletedSnapshotPayloadButRetainsBoundedFrontier(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 12}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/payload", Direction: HistoryEnd, ViewportRows: 3,
	})
	if err != nil || chunk.Continuation != "" {
		t.Fatalf("single-chunk history=%+v error=%v", chunk, err)
	}
	actor.mu.Lock()
	view := actor.historyViews["view/payload"]
	actor.mu.Unlock()
	if len(view.snapshot.payload) != 0 || view.snapshot.payloadSHA256 != "" {
		t.Fatal("completed history response retained encoded snapshot payload")
	}
	if view.firstAvailable == nil {
		t.Fatal("completed history response released its bounded navigation frontier")
	}
}

func TestSessionActorHistoryKeepsConstantNativeFrontierAcrossRepeatedScrolling(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 100}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	current, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Direction: HistoryEnd, ViewportRows: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	direction := HistoryBackward
	for index := 0; index < 1000; index++ {
		if current.Offset == 0 {
			direction = HistoryForward
		} else if current.Offset == current.ScreenStartOffset {
			direction = HistoryBackward
		}
		current, err = actor.ReadHistory(SemanticHistoryRequest{
			ViewID: "view-a", Anchor: current.Anchor, SnapshotID: current.SnapshotID, Direction: direction,
			Offset: current.Offset, ScrollDeltaRows: 1, ViewportRows: 3,
		})
		if err != nil {
			t.Fatalf("scroll %d: %v", index, err)
		}
	}
	liveAnchors := 0
	for _, anchor := range engine.anchors {
		if !anchor.closed {
			liveAnchors++
		}
	}
	if liveAnchors != 1 {
		t.Fatalf("live native history anchors=%d, want one retention frontier", liveAnchors)
	}
	actor.ReleaseHistory("view-a")
	for _, anchor := range engine.anchors {
		if !anchor.closed {
			t.Fatal("released repeated-scroll view retained a native history anchor")
		}
	}
}

func TestSessionActorHistoryScrollDeltaDoesNotChangeViewportHeight(t *testing.T) {
	const cols = 103
	const rows = 37
	engine := &fakeSemanticHistoryEngine{totalRows: 100}
	engine.frame = SemanticFrame{Width: cols, Height: rows}
	actor, err := NewSessionActor(engine, cols, rows, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	end, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Direction: HistoryEnd, ViewportRows: rows,
	})
	if err != nil {
		t.Fatal(err)
	}
	backward, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view-a", Anchor: end.Anchor, SnapshotID: end.SnapshotID, Direction: HistoryBackward,
		Offset: end.Offset, ScrollDeltaRows: 9, ViewportRows: rows,
	})
	if err != nil {
		t.Fatal(err)
	}
	if backward.Rows != rows || backward.Offset != end.Offset-9 {
		t.Fatalf("backward viewport rows=%d offset=%d, want rows=%d offset=%d", backward.Rows, backward.Offset, rows, end.Offset-9)
	}
}

func TestSessionActorHistorySupportsBoundedWindowRows(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 30}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}

	window, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/window", Direction: HistoryEnd, ViewportRows: 9,
	})
	if err != nil {
		t.Fatal(err)
	}
	if window.Rows != 9 || window.Offset != 21 || window.ScreenStartOffset != 21 {
		t.Fatalf("history window=%+v, want rows=9 offset=21", window)
	}
	if got := historyChunkFirstText(t, window); got != "row-21" {
		t.Fatalf("history window first row=%q, want row-21", got)
	}

	target := 10
	next, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/window", Anchor: window.Anchor, SnapshotID: window.SnapshotID,
		Direction: HistoryBackward, Offset: window.Offset, TargetOffset: &target, ViewportRows: 9,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Rows != 9 || next.Offset != target || next.ScreenStartOffset != 21 {
		t.Fatalf("scrolled history window=%+v, want rows=9 offset=%d", next, target)
	}
}

func TestSessionActorDirectHistoryTargetIsOneNativeCapture(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 1_000_037}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	first, err := actor.ReadHistory(SemanticHistoryRequest{ViewID: "view/direct", Direction: HistoryEnd, ViewportRows: 3})
	if err != nil {
		t.Fatal(err)
	}
	target := 7
	engine.calls = nil
	next, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/direct", Anchor: first.Anchor, SnapshotID: first.SnapshotID, Direction: HistoryBackward,
		Offset: first.Offset, TargetOffset: &target, ViewportRows: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Offset != target || historyChunkFirstText(t, next) != "row-7" {
		t.Fatalf("direct history target=%+v", next)
	}
	if got := strings.Join(engine.calls, ","); got != "history-total,history-anchor-row,history-track,history-read,history-anchor-row" {
		t.Fatalf("direct seek engine calls=%q", got)
	}
}

func TestSessionActorBoundaryHistoryTargetIsOneNativeCaptureAndClamps(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 1_000_037}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	target := 500_000
	window, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/boundary-direct", Direction: HistoryEnd, TargetOffset: &target, ViewportRows: 9,
	})
	if err != nil {
		t.Fatal(err)
	}
	if window.Offset != target || historyChunkFirstText(t, window) != "row-500000" {
		t.Fatalf("direct boundary history target=%+v", window)
	}
	if got := strings.Join(engine.calls, ","); got != "history-total,history-track,history-track,history-read,history-anchor-row" {
		t.Fatalf("direct boundary engine calls=%q", got)
	}

	beyondEnd := 2_000_000
	clamped, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/boundary-direct", Direction: HistoryEnd, TargetOffset: &beyondEnd, ViewportRows: 9,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := engine.totalRows - 9; clamped.Offset != want {
		t.Fatalf("clamped boundary offset=%d, want %d", clamped.Offset, want)
	}

	negative := -1
	if _, err := actor.ReadHistory(SemanticHistoryRequest{
		ViewID: "view/boundary-direct", Direction: HistoryStart, TargetOffset: &negative, ViewportRows: 9,
	}); !errors.Is(err, ErrSemanticHistoryAnchor) {
		t.Fatalf("negative boundary target error=%v", err)
	}
}

func TestSessionActorHistorySnapshotPreservesCanonicalViewportDimensions(t *testing.T) {
	for _, dimensions := range []struct{ cols, rows int }{
		{cols: 80, rows: 24},
		{cols: 103, rows: 37},
		{cols: 199, rows: 48},
		{cols: 500, rows: 48},
	} {
		t.Run(fmt.Sprintf("%dx%d", dimensions.cols, dimensions.rows), func(t *testing.T) {
			engine := &fakeSemanticHistoryEngine{totalRows: dimensions.rows * 3}
			engine.frame = SemanticFrame{Width: dimensions.cols, Height: dimensions.rows}
			actor, err := NewSessionActor(engine, dimensions.cols, dimensions.rows, NewPresentationStore(1))
			if err != nil {
				t.Fatal(err)
			}
			chunk, err := actor.ReadHistory(SemanticHistoryRequest{
				ViewID: "view", Direction: HistoryEnd, ViewportRows: dimensions.rows,
			})
			if err != nil {
				t.Fatal(err)
			}
			if chunk.Cols != dimensions.cols || chunk.Rows != dimensions.rows {
				t.Fatalf("history snapshot=%dx%d, want %dx%d", chunk.Cols, chunk.Rows, dimensions.cols, dimensions.rows)
			}
		})
	}
}
