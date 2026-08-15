package terminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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
			ViewID: "view-a", Anchor: current.Anchor, Direction: direction,
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
	if liveAnchors != 3 {
		t.Fatalf("live native history anchors=%d, want constant frontier of 3", liveAnchors)
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
		ViewID: "view-a", Anchor: end.Anchor, Direction: HistoryBackward,
		Offset: end.Offset, ScrollDeltaRows: 9, ViewportRows: rows,
	})
	if err != nil {
		t.Fatal(err)
	}
	if backward.Rows != rows || backward.Offset != end.Offset-9 {
		t.Fatalf("backward viewport rows=%d offset=%d, want rows=%d offset=%d", backward.Rows, backward.Offset, rows, end.Offset-9)
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
