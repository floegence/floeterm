//go:build floeterm_native

package nativevt

/*
#cgo CFLAGS: -I${SRCDIR}/generated/include -I${SRCDIR}/generated
#cgo LDFLAGS: ${SRCDIR}/generated/lib/libghostty-vt.a -lc++
#include "generated/adapter.h"
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
}
type Row struct{ Cells []Cell }
type Frame struct {
	Width, Height    int
	Rows             []Row
	CursorX, CursorY int
	CursorVisible    bool
	Alternate        bool
}
type Result struct {
	Title     string
	Bells     uint32
	Responses [][]byte
}

type Engine struct{ handle *C.NativeEngine }

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
	data := C.GoBytes(unsafe.Pointer(out.data), C.int(out.data_len))
	cells := unsafe.Slice((*C.NativeCell)(unsafe.Pointer(out.cells)), int(out.width)*int(out.height))
	f := Frame{Width: int(out.width), Height: int(out.height), Rows: make([]Row, int(out.height)), CursorX: int(out.cursor_x), CursorY: int(out.cursor_y), CursorVisible: out.cursor_visible != 0, Alternate: int(out.active_screen) != 0}
	for y := range f.Rows {
		f.Rows[y].Cells = make([]Cell, int(out.width))
		for x := range f.Rows[y].Cells {
			s := cells[y*int(out.width)+x]
			a, b := int(s.text_offset), int(s.text_offset+s.text_len)
			ha, hb := int(s.hyperlink_offset), int(s.hyperlink_offset+s.hyperlink_len)
			f.Rows[y].Cells[x] = Cell{Text: string(data[a:b]), Hyperlink: string(data[ha:hb]), Width: int(s.width), Bold: s.bold != 0, Italic: s.italic != 0}
		}
	}
	return f, nil
}
