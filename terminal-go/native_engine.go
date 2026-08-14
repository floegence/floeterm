//go:build floeterm_native

package terminal

import (
	"errors"
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

type nativeSemanticHistoryAnchor struct{ anchor *nativevt.Anchor }

func (a *nativeSemanticHistoryAnchor) Close() {
	if a != nil && a.anchor != nil {
		a.anchor.Close()
		a.anchor = nil
	}
}

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
	frame, err := semanticFrameFromNative(f)
	if err != nil {
		return SemanticFrame{}, err
	}
	totalRows, err := e.engine.HistoryTotalRows()
	if err != nil {
		return SemanticFrame{}, err
	}
	if totalRows < frame.Height {
		return SemanticFrame{}, errors.New("native history row count is smaller than the screen")
	}
	frame.History.TotalRows = totalRows
	frame.History.ScreenStartOffset = totalRows - frame.Height
	return frame, nil
}

func semanticFrameFromNative(f nativevt.Frame) (SemanticFrame, error) {
	if f.Cursor.Shape == "" {
		return SemanticFrame{}, errors.New("native cursor shape is missing")
	}
	cursor := SemanticCursor{X: f.Cursor.X, Y: f.Cursor.Y, Visible: f.Cursor.Visible, Shape: f.Cursor.Shape, Blinking: f.Cursor.Blinking, WideTail: f.Cursor.WideTail}
	if f.Cursor.ColorValue {
		cursor.Color = semanticColor(f.Cursor.Color)
	}
	out := SemanticFrame{Width: f.Width, Height: f.Height, BufferKind: "normal", Cursor: cursor, Rows: make([]SemanticRow, len(f.Rows))}
	if f.Alternate {
		out.BufferKind = "alternate"
	}
	out.Graphics = SemanticGraphics{
		Generation: f.Graphics.Generation,
		Images:     make([]SemanticGraphicImage, 0, len(f.Graphics.Images)),
		Placements: make([]SemanticGraphicPlacement, 0, len(f.Graphics.Placements)),
	}
	for _, image := range f.Graphics.Images {
		out.Graphics.Images = append(out.Graphics.Images, SemanticGraphicImage{
			ID: image.ID, Width: image.Width, Height: image.Height, Format: SemanticGraphicFormat(image.Format),
			Generation: image.Generation, Pixels: append([]byte(nil), image.Pixels...),
		})
	}
	for _, placement := range f.Graphics.Placements {
		out.Graphics.Placements = append(out.Graphics.Placements, SemanticGraphicPlacement{
			ImageID: placement.ImageID, PlacementID: placement.PlacementID, Z: placement.Z,
			ViewportColumn: placement.ViewportColumn, ViewportRow: placement.ViewportRow,
			GridColumns: placement.GridColumns, GridRows: placement.GridRows,
			Visible: placement.Visible, Virtual: placement.Virtual,
		})
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

func (e *nativeSemanticEngine) TrackHistoryCell(column, screenRow int) (SemanticHistoryAnchor, error) {
	if column < 0 || column > 65535 || screenRow < 0 || uint64(screenRow) > uint64(^uint32(0)) {
		return nil, errors.New("native history coordinate is invalid")
	}
	anchor, err := e.engine.TrackHistoryCell(uint16(column), uint32(screenRow))
	if err != nil {
		return nil, err
	}
	return &nativeSemanticHistoryAnchor{anchor: anchor}, nil
}

func (e *nativeSemanticEngine) HistoryAnchorScreenRow(anchor SemanticHistoryAnchor) (int, AnchorStatus, error) {
	native, ok := anchor.(*nativeSemanticHistoryAnchor)
	if !ok || native.anchor == nil {
		return 0, AnchorInvalid, nil
	}
	row, status, err := e.engine.HistoryAnchorScreenRow(native.anchor)
	return row, AnchorStatus(status), err
}

func (e *nativeSemanticEngine) HistoryTotalRows() (int, error) {
	return e.engine.HistoryTotalRows()
}

func (e *nativeSemanticEngine) ReadHistory(anchor SemanticHistoryAnchor, limit int) (SemanticFrame, AnchorStatus, error) {
	if limit <= 0 || limit > 65535 {
		return SemanticFrame{}, AnchorInvalid, errors.New("native history limit is invalid")
	}
	native, ok := anchor.(*nativeSemanticHistoryAnchor)
	if !ok || native.anchor == nil {
		return SemanticFrame{}, AnchorInvalid, nil
	}
	frame, status, err := e.engine.ReadHistory(native.anchor, uint16(limit))
	if err != nil || status != nativevt.AnchorValid {
		return SemanticFrame{}, AnchorStatus(status), err
	}
	semantic, err := semanticFrameFromNative(frame)
	return semantic, AnchorStatus(status), err
}
func (e *nativeSemanticEngine) Reset() error          { return e.engine.Reset() }
func (e *nativeSemanticEngine) Resize(c, r int) error { return e.engine.Resize(uint16(c), uint16(r)) }
func (e *nativeSemanticEngine) EncodeInput(i SemanticInput) ([]byte, error) {
	switch i.Kind {
	case "text":
		return e.engine.EncodeText(i.Text)
	case "key":
		action := 0
		switch i.Action {
		case "press":
			action = 1
		case "repeat":
			action = 2
		case "release":
			action = 3
		}
		return e.engine.EncodeKey(nativevt.KeyEvent{Code: i.Code, Text: i.Text, Action: action, Modifiers: i.Modifiers})
	default:
		return nil, errors.New("unsupported native semantic input")
	}
}
func (e *nativeSemanticEngine) Close() { e.engine.Close() }
