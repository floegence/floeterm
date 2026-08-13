package terminal

import "testing"

func TestSemanticPresentationWireFitsMaximumProductViewport(t *testing.T) {
	p := SemanticPresentation{Sequence: 1, Geometry: TerminalGeometry{Generation: 1, Cols: 199, Rows: 48}, State: TerminalState{Sequence: 1}, Frame: SemanticFrame{Width: 199, Height: 48, BufferKind: "normal", Rows: make([]SemanticRow, 48)}}
	for y := range p.Frame.Rows {
		p.Frame.Rows[y].Cells = make([]SemanticCell, 199)
		for x := range p.Frame.Rows[y].Cells {
			p.Frame.Rows[y].Cells[x] = SemanticCell{Width: 1, Style: SemanticStyle{Foreground: "default", Background: "default"}}
		}
	}
	data, err := EncodeSemanticPresentation(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) >= 256*1024 {
		t.Fatalf("encoded presentation = %d bytes", len(data))
	}
}

func TestPresentationStorePublishesAtomicLatestAndReliableFIFO(t *testing.T) {
	store := NewPresentationStore(2)
	first := SemanticPresentation{Sequence: 1, Geometry: TerminalGeometry{Cols: 80, Rows: 24}, Frame: SemanticFrame{Width: 80, Height: 24}}
	second := SemanticPresentation{Sequence: 2, Geometry: TerminalGeometry{Cols: 120, Rows: 40}, Frame: SemanticFrame{Width: 120, Height: 40}}
	if err := store.Publish(first); err != nil {
		t.Fatal(err)
	}
	if err := store.Publish(second); err != nil {
		t.Fatal(err)
	}
	latest, ok := store.Latest()
	if !ok || latest.Sequence != 2 || latest.Geometry != second.Geometry || latest.Frame.Width != 120 {
		t.Fatalf("latest=%+v ok=%v", latest, ok)
	}
	got, ok := store.Next()
	if !ok || got.Sequence != 1 || got.Geometry != first.Geometry {
		t.Fatalf("first=%+v ok=%v", got, ok)
	}
	got, ok = store.Next()
	if !ok || got.Sequence != 2 || got.Geometry != second.Geometry {
		t.Fatalf("second=%+v ok=%v", got, ok)
	}
}

func TestPresentationStoreDoesNotExposeMutableOwnedBuffers(t *testing.T) {
	store := NewPresentationStore(1)
	p := SemanticPresentation{Sequence: 1, Frame: SemanticFrame{Rows: []SemanticRow{{Cells: []SemanticCell{{Text: "界"}}}}}}
	if err := store.Publish(p); err != nil {
		t.Fatal(err)
	}
	p.Frame.Rows[0].Cells[0].Text = "mutated"
	got, _ := store.Next()
	if got.Frame.Rows[0].Cells[0].Text != "界" {
		t.Fatalf("store retained caller buffer: %+v", got)
	}
}

func TestPresentationStoreTakeLatestDropsSupersededFrames(t *testing.T) {
	store := NewPresentationStore(2)
	for sequence := uint64(1); sequence <= 2; sequence++ {
		if err := store.Publish(SemanticPresentation{Sequence: sequence}); err != nil {
			t.Fatal(err)
		}
	}
	latest, ok := store.TakeLatest()
	if !ok || latest.Sequence != 2 {
		t.Fatalf("latest=%+v ok=%v", latest, ok)
	}
	if _, ok := store.Next(); ok {
		t.Fatal("superseded frame remained queued after latest delivery")
	}
	if _, ok := store.TakeLatest(); ok {
		t.Fatal("latest delivery repeated without a newly published presentation")
	}
	if err := store.Publish(SemanticPresentation{Sequence: 3}); err != nil {
		t.Fatalf("store remained backpressured after latest delivery: %v", err)
	}
}
