package terminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

func TestSemanticPresentationWireCarriesOwnedGraphicsAndFailsClosedWhenOversized(t *testing.T) {
	p := SemanticPresentation{
		Sequence: 1,
		Geometry: TerminalGeometry{Generation: 1, Cols: 2, Rows: 1},
		State:    TerminalState{Sequence: 1},
		Frame: SemanticFrame{
			Width: 2, Height: 1, BufferKind: "normal",
			Cursor: SemanticCursor{X: 1, Y: 0, Visible: true, Shape: "bar", Blinking: true, Color: "rgb:010203"},
			Rows:   []SemanticRow{{Cells: []SemanticCell{{Width: 1}, {Width: 1}}}},
			Graphics: SemanticGraphics{
				Generation: 3,
				Images:     []SemanticGraphicImage{{ID: 7, Width: 1, Height: 1, Format: SemanticGraphicRGB, Generation: 2, Pixels: []byte{1, 2, 3}}},
				Placements: []SemanticGraphicPlacement{{ImageID: 7, PlacementID: 9, ViewportColumn: 1, ViewportRow: 0, GridColumns: 1, GridRows: 1, Visible: true}},
			},
		},
	}
	data, err := EncodeSemanticPresentation(p)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Frame struct {
			Graphics SemanticGraphics `json:"graphics"`
			Cursor   SemanticCursor   `json:"cursor"`
		} `json:"frame"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Frame.Graphics.Generation != 3 || len(wire.Frame.Graphics.Images) != 1 || !bytes.Equal(wire.Frame.Graphics.Images[0].Pixels, []byte{1, 2, 3}) || len(wire.Frame.Graphics.Placements) != 1 {
		t.Fatalf("wire graphics = %+v", wire.Frame.Graphics)
	}
	if wire.Frame.Cursor != p.Frame.Cursor {
		t.Fatalf("wire cursor = %+v, want %+v", wire.Frame.Cursor, p.Frame.Cursor)
	}
	invalidCursor := p
	invalidCursor.Frame.Cursor.Shape = "unknown"
	if _, err := EncodeSemanticPresentation(invalidCursor); err == nil {
		t.Fatal("invalid semantic cursor was encoded")
	}

	p.Frame.Graphics.Images[0].Pixels = make([]byte, 256*1024)
	if _, err := EncodeSemanticPresentation(p); !errors.Is(err, ErrPresentationBackpressure) {
		t.Fatalf("oversized graphics error = %v, want ErrPresentationBackpressure", err)
	}
}

func TestSemanticPresentationWireFitsMaximumProductViewport(t *testing.T) {
	p := SemanticPresentation{Sequence: 1, Geometry: TerminalGeometry{Generation: 1, Cols: 199, Rows: 48}, State: TerminalState{Sequence: 1}, Frame: SemanticFrame{Width: 199, Height: 48, BufferKind: "normal", Cursor: SemanticCursor{Shape: "block"}, Rows: make([]SemanticRow, 48)}}
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

func TestSemanticPresentationWireNormalizesEmptyGraphicsInventory(t *testing.T) {
	p := SemanticPresentation{
		Sequence: 1,
		Geometry: TerminalGeometry{Generation: 1, Cols: 1, Rows: 1},
		State:    TerminalState{Sequence: 1},
		Frame: SemanticFrame{
			Width: 1, Height: 1, BufferKind: "normal",
			Cursor: SemanticCursor{Shape: "block"},
			Rows:   []SemanticRow{{Cells: []SemanticCell{{Width: 1}}}},
		},
	}
	data, err := EncodeSemanticPresentation(p)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Frame struct {
			Graphics struct {
				Images, Placements []json.RawMessage
			} `json:"graphics"`
		} `json:"frame"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Frame.Graphics.Images == nil || wire.Frame.Graphics.Placements == nil {
		t.Fatalf("empty graphics encoded as null: %s", data)
	}
}

func TestPresentationStorePublishesOneAtomicLatestSlot(t *testing.T) {
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
}

func TestPresentationStoreDoesNotExposeMutableOwnedBuffers(t *testing.T) {
	store := NewPresentationStore(1)
	p := SemanticPresentation{Sequence: 1, Frame: SemanticFrame{Rows: []SemanticRow{{Cells: []SemanticCell{{Text: "界"}}}}}}
	if err := store.Publish(p); err != nil {
		t.Fatal(err)
	}
	p.Frame.Rows[0].Cells[0].Text = "mutated"
	got, _ := store.Latest()
	if got.Frame.Rows[0].Cells[0].Text != "界" {
		t.Fatalf("store retained caller buffer: %+v", got)
	}
}
