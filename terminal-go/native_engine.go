//go:build floeterm_native

package terminal

import "github.com/floegence/floeterm/terminal-go/internal/nativevt"

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
			out.Rows[y].Cells[x] = SemanticCell{Text: c.Text, Hyperlink: c.Hyperlink, Width: uint8(c.Width), Style: SemanticStyle{Bold: c.Bold, Italic: c.Italic}}
		}
	}
	return out, nil
}
func (e *nativeSemanticEngine) Resize(c, r int) error { return e.engine.Resize(uint16(c), uint16(r)) }
func (e *nativeSemanticEngine) EncodeInput(i SemanticInput) ([]byte, error) {
	return e.engine.EncodeText(i.Text)
}
func (e *nativeSemanticEngine) Close() { e.engine.Close() }
