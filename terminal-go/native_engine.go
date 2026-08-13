//go:build floeterm_native

package terminal

import (
	"fmt"

	"github.com/floegence/floeterm/terminal-go/internal/nativevt"
)

func semanticColor(color nativevt.Color) string {
	switch color.Kind {
	case 1:
		return fmt.Sprintf("indexed:%d", color.PaletteIndex)
	case 2:
		return fmt.Sprintf("rgb:%02x%02x%02x", color.R, color.G, color.B)
	default:
		return "default"
	}
}

func semanticCellWidth(ghosttyWide int) (uint8, error) {
	switch ghosttyWide {
	case 0:
		return 1, nil
	case 1:
		return 2, nil
	case 2, 3:
		return 0, nil
	default:
		return 0, fmt.Errorf("invalid Ghostty cell wide value: %d", ghosttyWide)
	}
}

type nativeSemanticEngine struct{ engine *nativevt.Engine }

func NewNativeSemanticEngine(cols, rows int) (SemanticEngine, error) {
	e, err := nativevt.New(uint16(cols), uint16(rows))
	if err != nil {
		return nil, err
	}
	return &nativeSemanticEngine{engine: e}, nil
}

func newProductSemanticEngine(cols, rows int) (SemanticEngine, error) {
	return NewNativeSemanticEngine(cols, rows)
}
func (e *nativeSemanticEngine) ApplyOutput(data []byte) (TerminalState, error) {
	r, err := e.engine.Apply(data)
	return TerminalState{Title: r.Title, Bell: uint64(r.Bells)}, err
}
func (e *nativeSemanticEngine) CaptureFrame() (SemanticFrame, error) {
	f, err := e.engine.Capture()
	if err != nil {
		return SemanticFrame{}, err
	}
	out := SemanticFrame{Width: f.Width, Height: f.Height, BufferKind: "normal", Cursor: SemanticCursor{X: f.CursorX, Y: f.CursorY, Visible: f.CursorVisible}, Rows: make([]SemanticRow, len(f.Rows))}
	if f.Alternate {
		out.BufferKind = "alternate"
	}
	for y := range f.Rows {
		out.Rows[y].Cells = make([]SemanticCell, len(f.Rows[y].Cells))
		for x, c := range f.Rows[y].Cells {
			width, widthErr := semanticCellWidth(c.Width)
			if widthErr != nil {
				return SemanticFrame{}, widthErr
			}
			out.Rows[y].Cells[x] = SemanticCell{Text: c.Text, Hyperlink: c.Hyperlink, Width: width, Style: SemanticStyle{Foreground: semanticColor(c.Foreground), Background: semanticColor(c.Background), Bold: c.Bold, Italic: c.Italic}}
		}
	}
	return out, nil
}
func (e *nativeSemanticEngine) Resize(c, r int) error { return e.engine.Resize(uint16(c), uint16(r)) }
func (e *nativeSemanticEngine) EncodeInput(i SemanticInput) ([]byte, error) {
	return e.engine.EncodeText(i.Text)
}
func (e *nativeSemanticEngine) Close() { e.engine.Close() }
