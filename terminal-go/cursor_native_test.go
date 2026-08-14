//go:build floeterm_native

package terminal

import "testing"

func TestNativePresentationPreservesCursorVisualState(t *testing.T) {
	engine, err := NewNativeSemanticEngine(8, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	initial, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if !initial.Cursor.Visible || initial.Cursor.Shape != "block" {
		t.Fatalf("initial cursor=%+v, want visible block", initial.Cursor)
	}

	if _, err := engine.ApplyOutput([]byte("\x1b[5 q\x1b[?25l\x1b[3;4H")); err != nil {
		t.Fatal(err)
	}
	hidden, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if hidden.Cursor.Visible || hidden.Cursor.X != 3 || hidden.Cursor.Y != 2 {
		t.Fatalf("hidden cursor=%+v", hidden.Cursor)
	}
	if hidden.Cursor.Shape != "bar" || !hidden.Cursor.Blinking {
		t.Fatalf("hidden cursor=%+v, want blinking bar", hidden.Cursor)
	}

	if _, err := engine.ApplyOutput([]byte("\x1b[?25h\x1b[4 q\x1b]12;#010203\x07")); err != nil {
		t.Fatal(err)
	}
	shown, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if !shown.Cursor.Visible || shown.Cursor.Shape != "underline" || shown.Cursor.Blinking || shown.Cursor.X != 3 || shown.Cursor.Y != 2 {
		t.Fatalf("shown cursor=%+v", shown.Cursor)
	}
	if shown.Cursor.Color != "rgb:010203" {
		t.Fatalf("shown cursor color=%q, want rgb:010203", shown.Cursor.Color)
	}
}

func TestNativeCursorTracksWideCombiningAlternateAndResize(t *testing.T) {
	engine, err := NewNativeSemanticEngine(10, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	if _, err := engine.ApplyOutput([]byte("界e\u0301")); err != nil {
		t.Fatal(err)
	}
	unicodeFrame, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if unicodeFrame.Cursor.X != 3 || unicodeFrame.Cursor.Y != 0 {
		t.Fatalf("cursor after wide+combining=%+v, want (3,0)", unicodeFrame.Cursor)
	}

	if _, err := engine.ApplyOutput([]byte("\x1b[?1049h\x1b[3;5H")); err != nil {
		t.Fatal(err)
	}
	alternate, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if alternate.BufferKind != "alternate" || alternate.Cursor.X != 4 || alternate.Cursor.Y != 2 {
		t.Fatalf("alternate cursor=%+v buffer=%q", alternate.Cursor, alternate.BufferKind)
	}

	if err := engine.Resize(3, 2); err != nil {
		t.Fatal(err)
	}
	resized, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if resized.Cursor.X < 0 || resized.Cursor.X >= 3 || resized.Cursor.Y < 0 || resized.Cursor.Y >= 2 {
		t.Fatalf("resized cursor escaped frame: %+v frame=%dx%d", resized.Cursor, resized.Width, resized.Height)
	}
}
