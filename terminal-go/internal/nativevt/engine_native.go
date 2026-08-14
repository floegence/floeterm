//go:build floeterm_native

package nativevt

/*
#cgo CFLAGS: -I${SRCDIR}/generated/include -I${SRCDIR}/generated
#cgo LDFLAGS: ${SRCDIR}/generated/lib/libghostty-vt.a -lc++
#include "generated/adapter.h"
int floeterm_native_history_total_rows(NativeEngine *engine, size_t *rows);
int floeterm_native_anchor_screen_row(NativeAnchor *anchor, uint32_t *row);
typedef struct {
  uint16_t x;
  uint16_t y;
  uint8_t visible;
  uint8_t blinking;
  uint8_t shape;
  uint8_t wide_tail;
  uint8_t color_has_value;
  uint8_t color_r;
  uint8_t color_g;
  uint8_t color_b;
} FloetermCursorInfo;
int floeterm_native_cursor_info(NativeEngine *engine, FloetermCursorInfo *out);
*/
import "C"

import (
	"errors"
	"runtime"
	"unsafe"
)

type Cell struct {
	Text, Hyperlink string
	Width           int
	Bold, Italic    bool
	Foreground      Color
	Background      Color
}
type Color struct {
	Kind         int
	R, G, B      uint8
	PaletteIndex uint8
}
type Row struct{ Cells []Cell }
type GraphicImage struct {
	ID, Width, Height uint32
	Format            int
	Generation        uint64
	Pixels            []byte
}
type GraphicPlacement struct {
	ImageID, PlacementID  uint32
	Z, ViewportColumn     int32
	ViewportRow           int32
	GridColumns, GridRows uint32
	Visible, Virtual      bool
}
type Graphics struct {
	Generation uint64
	Images     []GraphicImage
	Placements []GraphicPlacement
}
type Frame struct {
	Width, Height int
	Rows          []Row
	Cursor        Cursor
	Alternate     bool
	Graphics      Graphics
}
type Cursor struct {
	X, Y       int
	Visible    bool
	Blinking   bool
	Shape      string
	WideTail   bool
	Color      Color
	ColorValue bool
}
type Result struct {
	Title     string
	Bells     uint32
	Responses [][]byte
}

type Anchor struct{ handle *C.NativeAnchor }

type AnchorStatus uint8

const (
	AnchorValid AnchorStatus = iota
	AnchorInvalid
)

type Engine struct{ handle *C.NativeEngine }

func (a *Anchor) Close() {
	if a != nil && a.handle != nil {
		C.native_anchor_free(a.handle)
		a.handle = nil
	}
}

func New(cols, rows uint16) (*Engine, error) {
	h := C.native_engine_new(C.uint16_t(cols), C.uint16_t(rows))
	if h == nil {
		return nil, errors.New("create native Ghostty engine")
	}
	return &Engine{handle: h}, nil
}

func (e *Engine) Close() {
	if e != nil && e.handle != nil {
		C.native_engine_free(e.handle)
		e.handle = nil
	}
}
func (e *Engine) Apply(data []byte) (Result, error) {
	if e == nil || e.handle == nil {
		return Result{}, errors.New("native engine closed")
	}
	var ptr *C.uint8_t
	if len(data) > 0 {
		ptr = (*C.uint8_t)(unsafe.Pointer(&data[0]))
	}
	var out C.NativeOutputResult
	if C.native_engine_write_events(e.handle, ptr, C.size_t(len(data)), &out) == 0 {
		return Result{}, errors.New("apply native output")
	}
	defer C.native_output_result_free(&out)
	runtime.KeepAlive(data)
	r := Result{Title: string(C.GoBytes(unsafe.Pointer(out.title), C.int(out.title_len))), Bells: uint32(out.bells)}
	for _, v := range unsafe.Slice((*C.NativeBytes)(unsafe.Pointer(out.responses)), int(out.responses_len)) {
		r.Responses = append(r.Responses, C.GoBytes(unsafe.Pointer(v.data), C.int(v.len)))
	}
	return r, nil
}
func (e *Engine) Resize(cols, rows uint16) error {
	if e == nil || e.handle == nil || C.native_engine_resize(e.handle, C.uint16_t(cols), C.uint16_t(rows), 8, 16) == 0 {
		return errors.New("resize native engine")
	}
	return nil
}
func (e *Engine) Reset() error {
	if e == nil || e.handle == nil {
		return errors.New("native engine closed")
	}
	C.native_engine_reset(e.handle)
	return nil
}
func (e *Engine) EncodeText(text string) ([]byte, error) { return []byte(text), nil }
func (e *Engine) Capture() (Frame, error) {
	if e == nil || e.handle == nil {
		return Frame{}, errors.New("native engine closed")
	}
	var out C.NativeFrame
	if C.native_capture_frame(e.handle, &out) == 0 {
		return Frame{}, errors.New("capture native frame")
	}
	defer C.native_frame_free(&out)
	var cursor C.FloetermCursorInfo
	if C.floeterm_native_cursor_info(e.handle, &cursor) == 0 {
		return Frame{}, errors.New("capture native cursor")
	}
	return frameFromNative(&out, &cursor)
}

func frameFromNative(out *C.NativeFrame, cursor *C.FloetermCursorInfo) (Frame, error) {
	if out == nil || out.width == 0 || out.height == 0 || out.cells == nil {
		return Frame{}, errors.New("invalid native frame")
	}
	data := C.GoBytes(unsafe.Pointer(out.data), C.int(out.data_len))
	cells := unsafe.Slice((*C.NativeCell)(unsafe.Pointer(out.cells)), int(out.width)*int(out.height))
	nativeCursor := Cursor{Shape: "block"}
	if cursor != nil {
		shape, ok := cursorShape(int(cursor.shape))
		if !ok {
			return Frame{}, errors.New("invalid native cursor shape")
		}
		nativeCursor = Cursor{
			X: int(cursor.x), Y: int(cursor.y), Visible: cursor.visible != 0, Blinking: cursor.blinking != 0,
			Shape: shape, WideTail: cursor.wide_tail != 0, ColorValue: cursor.color_has_value != 0,
			Color: Color{Kind: 2, R: uint8(cursor.color_r), G: uint8(cursor.color_g), B: uint8(cursor.color_b)},
		}
	}
	f := Frame{Width: int(out.width), Height: int(out.height), Rows: make([]Row, int(out.height)), Cursor: nativeCursor, Alternate: int(out.active_screen) != 0}
	f.Graphics.Generation = uint64(out.graphics_generation)
	for _, source := range unsafe.Slice((*C.NativeImage)(unsafe.Pointer(out.images)), int(out.images_len)) {
		f.Graphics.Images = append(f.Graphics.Images, GraphicImage{
			ID: uint32(source.id), Width: uint32(source.width), Height: uint32(source.height),
			Format: int(source.format), Generation: uint64(source.generation),
			Pixels: C.GoBytes(unsafe.Pointer(source.pixels), C.int(source.pixels_len)),
		})
	}
	for _, source := range unsafe.Slice((*C.NativePlacement)(unsafe.Pointer(out.placements)), int(out.placements_len)) {
		f.Graphics.Placements = append(f.Graphics.Placements, GraphicPlacement{
			ImageID: uint32(source.image_id), PlacementID: uint32(source.placement_id), Z: int32(source.z),
			ViewportColumn: int32(source.viewport_col), ViewportRow: int32(source.viewport_row),
			GridColumns: uint32(source.grid_cols), GridRows: uint32(source.grid_rows),
			Visible: source.visible != 0, Virtual: source.is_virtual != 0,
		})
	}
	for y := range f.Rows {
		f.Rows[y].Cells = make([]Cell, int(out.width))
		for x := range f.Rows[y].Cells {
			s := cells[y*int(out.width)+x]
			a, b := int(s.text_offset), int(s.text_offset+s.text_len)
			ha, hb := int(s.hyperlink_offset), int(s.hyperlink_offset+s.hyperlink_len)
			if a < 0 || b < a || b > len(data) || ha < 0 || hb < ha || hb > len(data) {
				return Frame{}, errors.New("invalid native frame offsets")
			}
			f.Rows[y].Cells[x] = Cell{
				Text: string(data[a:b]), Hyperlink: string(data[ha:hb]), Width: int(s.width),
				Bold: s.bold != 0, Italic: s.italic != 0,
				Foreground: Color{Kind: int(s.foreground_kind), R: uint8(s.foreground_r), G: uint8(s.foreground_g), B: uint8(s.foreground_b), PaletteIndex: uint8(s.foreground_index)},
				Background: Color{Kind: int(s.background_kind), R: uint8(s.background_r), G: uint8(s.background_g), B: uint8(s.background_b), PaletteIndex: uint8(s.background_index)},
			}
		}
	}
	return f, nil
}

func cursorShape(value int) (string, bool) {
	switch value {
	case 0:
		return "bar", true
	case 1:
		return "block", true
	case 2:
		return "underline", true
	case 3:
		return "hollow", true
	default:
		return "", false
	}
}

func (e *Engine) TrackHistoryCell(x uint16, y uint32) (*Anchor, error) {
	if e == nil || e.handle == nil {
		return nil, errors.New("native engine closed")
	}
	handle := C.native_track_screen_cell(e.handle, C.uint16_t(x), C.uint32_t(y))
	if handle == nil {
		return nil, errors.New("track native history cell")
	}
	return &Anchor{handle: handle}, nil
}

func (e *Engine) ViewportActive() (bool, error) {
	if e == nil || e.handle == nil {
		return false, errors.New("native engine closed")
	}
	var active C.uint8_t
	if C.native_viewport_active(e.handle, &active) == 0 {
		return false, errors.New("read native viewport state")
	}
	return active != 0, nil
}

func (e *Engine) HistoryTotalRows() (int, error) {
	if e == nil || e.handle == nil {
		return 0, errors.New("native engine closed")
	}
	var rows C.size_t
	if C.floeterm_native_history_total_rows(e.handle, &rows) == 0 {
		return 0, errors.New("read native history row count")
	}
	if uint64(rows) > uint64(^uint(0)>>1) {
		return 0, errors.New("native history row count overflows int")
	}
	return int(rows), nil
}

func (e *Engine) HistoryAnchorScreenRow(anchor *Anchor) (int, AnchorStatus, error) {
	if e == nil || e.handle == nil {
		return 0, AnchorInvalid, errors.New("native engine closed")
	}
	if anchor == nil || anchor.handle == nil {
		return 0, AnchorInvalid, errors.New("invalid native history anchor")
	}
	var row C.uint32_t
	result := C.floeterm_native_anchor_screen_row(anchor.handle, &row)
	if result == 2 {
		return 0, AnchorInvalid, nil
	}
	if result == 0 {
		return 0, AnchorInvalid, errors.New("read native history anchor")
	}
	return int(row), AnchorValid, nil
}

func (e *Engine) ReadHistory(anchor *Anchor, limit uint16) (Frame, AnchorStatus, error) {
	if e == nil || e.handle == nil {
		return Frame{}, AnchorInvalid, errors.New("native engine closed")
	}
	if anchor == nil || anchor.handle == nil || limit == 0 {
		return Frame{}, AnchorInvalid, errors.New("invalid native history query")
	}
	var out C.NativeFrame
	result := C.native_read_history(e.handle, anchor.handle, C.uint16_t(limit), &out)
	if result == 2 {
		return Frame{}, AnchorInvalid, nil
	}
	if result == 0 {
		return Frame{}, AnchorInvalid, errors.New("read native history")
	}
	defer C.native_frame_free(&out)
	frame, err := frameFromNative(&out, nil)
	if err != nil {
		return Frame{}, AnchorInvalid, err
	}
	return frame, AnchorValid, nil
}
