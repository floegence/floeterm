//go:build floeterm_native

package terminal

import (
	"bytes"
	"fmt"
	"os"
	"testing"

	"github.com/creack/pty"
)

func TestRealNativePresentationOwnsKittyGraphicsInventory(t *testing.T) {
	engine, err := NewNativeSemanticEngine(8, 3)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()

	if _, err := engine.ApplyOutput([]byte("\x1b_Ga=T,f=24,s=1,v=1,i=7,q=2;AQID\x1b\\")); err != nil {
		t.Fatal(err)
	}
	frame, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if frame.Graphics.Generation == 0 || len(frame.Graphics.Images) != 1 || len(frame.Graphics.Placements) != 1 {
		t.Fatalf("graphics inventory = %+v", frame.Graphics)
	}
	image := frame.Graphics.Images[0]
	if image.ID != 7 || image.Width != 1 || image.Height != 1 || image.Format != SemanticGraphicRGB || !bytes.Equal(image.Pixels, []byte{1, 2, 3}) {
		t.Fatalf("image = %+v pixels=%v", image, image.Pixels)
	}
	placement := frame.Graphics.Placements[0]
	if placement.ImageID != 7 || !placement.Visible || placement.GridColumns != 1 || placement.GridRows != 1 {
		t.Fatalf("placement = %+v", placement)
	}

	if _, err := engine.ApplyOutput([]byte("\x1b_Ga=d,d=I,i=7,q=2\x1b\\")); err != nil {
		t.Fatal(err)
	}
	afterDelete, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	if len(afterDelete.Graphics.Images) != 0 || len(afterDelete.Graphics.Placements) != 0 {
		t.Fatalf("deleted graphics retained: %+v", afterDelete.Graphics)
	}
	if !bytes.Equal(frame.Graphics.Images[0].Pixels, []byte{1, 2, 3}) {
		t.Fatalf("captured pixels alias native memory: %v", frame.Graphics.Images[0].Pixels)
	}
}

func TestRealNativeActorProducesImmutablePresentation(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(4)
	actor, err := NewSessionActor(engine, 20, 4, store)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.Close()
	if _, err := actor.ApplyPTYOutput([]byte("\x1b[?1049h\x1b]8;;https://test\x1b\\界e\u0301\x1b]8;;\x1b\\")); err != nil {
		t.Fatal(err)
	}
	p, ok := store.Latest()
	if !ok || p.Frame.BufferKind != "alternate" || p.Frame.Rows[0].Cells[0].Text != "界" || p.Frame.Rows[0].Cells[0].Hyperlink != "https://test" {
		t.Fatalf("presentation=%+v", p)
	}
	if p.Frame.Rows[0].Cells[0].Width != 2 || p.Frame.Rows[0].Cells[1].Width != 0 {
		t.Fatalf("wide grapheme cells=%+v, want leading width 2 and continuation width 0", p.Frame.Rows[0].Cells[:2])
	}
	if err := actor.Resize(30, 6); err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("x")); err != nil {
		t.Fatal(err)
	}
	latest, _ := store.Latest()
	if latest.Geometry.Cols != 30 || latest.Frame.Width != 30 {
		t.Fatalf("geometry=%+v frame=%dx%d", latest.Geometry, latest.Frame.Width, latest.Frame.Height)
	}
}

func TestRealNativePresentationPreservesInverseCellStyle(t *testing.T) {
	engine, err := NewNativeSemanticEngine(4, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	if _, err := engine.ApplyOutput([]byte("\x1b[31;44;7mX\x1b[0m")); err != nil {
		t.Fatal(err)
	}
	frame, err := engine.CaptureFrame()
	if err != nil {
		t.Fatal(err)
	}
	cell := frame.Rows[0].Cells[0]
	if cell.Text != "X" || !cell.Style.Inverse || cell.Style.Foreground != "indexed:1" || cell.Style.Background != "indexed:4" {
		t.Fatalf("inverse semantic cell = %+v", cell)
	}
}

func TestRealNativeKeyEncoderUsesCurrentTerminalModes(t *testing.T) {
	for _, test := range []struct {
		name   string
		setup  string
		intent SemanticInput
		want   string
	}{
		{name: "enter", intent: SemanticInput{Kind: "key", Code: "Enter", Action: "press"}, want: "\r"},
		{name: "normal cursor", intent: SemanticInput{Kind: "key", Code: "ArrowUp", Action: "press"}, want: "\x1b[A"},
		{name: "application cursor", setup: "\x1b[?1h", intent: SemanticInput{Kind: "key", Code: "ArrowUp", Action: "press"}, want: "\x1bOA"},
		{name: "control a readline start", intent: SemanticInput{Kind: "key", Code: "KeyA", Text: "a", Action: "press", Modifiers: SemanticModifierControl}, want: "\x01"},
		{name: "control c interrupt", intent: SemanticInput{Kind: "key", Code: "KeyC", Text: "c", Action: "press", Modifiers: SemanticModifierControl}, want: "\x03"},
		{name: "control d eof", intent: SemanticInput{Kind: "key", Code: "KeyD", Text: "d", Action: "press", Modifiers: SemanticModifierControl}, want: "\x04"},
		{name: "control e readline end", intent: SemanticInput{Kind: "key", Code: "KeyE", Text: "e", Action: "press", Modifiers: SemanticModifierControl}, want: "\x05"},
		{name: "control h backspace", intent: SemanticInput{Kind: "key", Code: "KeyH", Text: "h", Action: "press", Modifiers: SemanticModifierControl}, want: "\x08"},
		{name: "control k kill end", intent: SemanticInput{Kind: "key", Code: "KeyK", Text: "k", Action: "press", Modifiers: SemanticModifierControl}, want: "\x0b"},
		{name: "control l clear", intent: SemanticInput{Kind: "key", Code: "KeyL", Text: "l", Action: "press", Modifiers: SemanticModifierControl}, want: "\x0c"},
		{name: "control p previous", intent: SemanticInput{Kind: "key", Code: "KeyP", Text: "p", Action: "press", Modifiers: SemanticModifierControl}, want: "\x10"},
		{name: "control r search", intent: SemanticInput{Kind: "key", Code: "KeyR", Text: "r", Action: "press", Modifiers: SemanticModifierControl}, want: "\x12"},
		{name: "control u kill start", intent: SemanticInput{Kind: "key", Code: "KeyU", Text: "u", Action: "press", Modifiers: SemanticModifierControl}, want: "\x15"},
		{name: "control w delete word", intent: SemanticInput{Kind: "key", Code: "KeyW", Text: "w", Action: "press", Modifiers: SemanticModifierControl}, want: "\x17"},
		{name: "control z suspend", intent: SemanticInput{Kind: "key", Code: "KeyZ", Text: "z", Action: "press", Modifiers: SemanticModifierControl}, want: "\x1a"},
		{name: "alt letter", intent: SemanticInput{Kind: "key", Code: "KeyB", Text: "b", Action: "press", Modifiers: SemanticModifierAlt}, want: "\x1bb"},
		{name: "home", intent: SemanticInput{Kind: "key", Code: "Home", Action: "press"}, want: "\x1b[H"},
		{name: "end", intent: SemanticInput{Kind: "key", Code: "End", Action: "press"}, want: "\x1b[F"},
		{name: "delete", intent: SemanticInput{Kind: "key", Code: "Delete", Action: "press"}, want: "\x1b[3~"},
		{name: "page up", intent: SemanticInput{Kind: "key", Code: "PageUp", Action: "press"}, want: "\x1b[5~"},
		{name: "page down", intent: SemanticInput{Kind: "key", Code: "PageDown", Action: "press"}, want: "\x1b[6~"},
		{name: "shift tab", intent: SemanticInput{Kind: "key", Code: "Tab", Action: "press", Modifiers: SemanticModifierShift}, want: "\x1b[Z"},
		{name: "control left", intent: SemanticInput{Kind: "key", Code: "ArrowLeft", Action: "press", Modifiers: SemanticModifierControl}, want: "\x1b[1;5D"},
		{name: "control right", intent: SemanticInput{Kind: "key", Code: "ArrowRight", Action: "press", Modifiers: SemanticModifierControl}, want: "\x1b[1;5C"},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine, err := NewNativeSemanticEngine(20, 4)
			if err != nil {
				t.Fatal(err)
			}
			defer engine.Close()
			if test.setup != "" {
				if _, err := engine.ApplyOutput([]byte(test.setup)); err != nil {
					t.Fatal(err)
				}
			}
			got, err := engine.EncodeInput(test.intent)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.want {
				t.Fatalf("encoded key = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRealNativeKeyEncoderCoversEveryControlLetter(t *testing.T) {
	for letter := byte('A'); letter <= 'Z'; letter++ {
		t.Run(string(letter), func(t *testing.T) {
			engine, err := NewNativeSemanticEngine(20, 4)
			if err != nil {
				t.Fatal(err)
			}
			defer engine.Close()
			got, err := engine.EncodeInput(SemanticInput{
				Kind: "key", Code: "Key" + string(letter), Text: string(letter + ('a' - 'A')),
				Action: "press", Modifiers: SemanticModifierControl,
			})
			if err != nil {
				t.Fatal(err)
			}
			want := []byte{letter & 0x1f}
			switch letter {
			case 'I', 'M':
				want = []byte(fmt.Sprintf("\x1b[%d;5u", letter+('a'-'A')))
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("encoded Ctrl+%c = %q, want %q", letter, got, want)
			}
		})
	}
}

func TestRealNativeKeyEncoderCoversTerminalControlPunctuation(t *testing.T) {
	for _, test := range []struct {
		name       string
		code, text string
		modifiers  uint16
		want       []byte
	}{
		{name: "control space", code: "Space", text: " ", modifiers: SemanticModifierControl, want: []byte{0}},
		{name: "control bracket left", code: "BracketLeft", text: "[", modifiers: SemanticModifierControl, want: []byte("\x1b[91;5u")},
		{name: "control backslash", code: "Backslash", text: "\\", modifiers: SemanticModifierControl, want: []byte{0x1c}},
		{name: "control bracket right", code: "BracketRight", text: "]", modifiers: SemanticModifierControl, want: []byte{0x1d}},
		{name: "control caret", code: "Digit6", text: "^", modifiers: SemanticModifierControl | SemanticModifierShift, want: []byte{0x1e}},
		{name: "control underscore", code: "Minus", text: "_", modifiers: SemanticModifierControl | SemanticModifierShift, want: []byte{0x1f}},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine, err := NewNativeSemanticEngine(20, 4)
			if err != nil {
				t.Fatal(err)
			}
			defer engine.Close()
			got, err := engine.EncodeInput(SemanticInput{
				Kind: "key", Code: test.code, Text: test.text, Action: "press", Modifiers: test.modifiers,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, test.want) {
				t.Fatalf("encoded key = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRealNativeKeyReleaseWithoutReportEventsProducesNoPTYBytes(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	got, err := engine.EncodeInput(SemanticInput{Kind: "key", Code: "Enter", Action: "release"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("default key release encoded unexpected PTY bytes %q", got)
	}
}

func TestRealNativeKeyEncoderReportsKittyKeyboardEvents(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	if _, err := engine.ApplyOutput([]byte("\x1b[>3u")); err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name   string
		code   string
		text   string
		action string
		want   string
	}{
		{name: "control a press", code: "KeyA", text: "a", action: "press", want: "\x1b[97;5u"},
		{name: "control a repeat", code: "KeyA", text: "a", action: "repeat", want: "\x1b[97;5:2u"},
		{name: "control a release", code: "KeyA", text: "a", action: "release", want: "\x1b[97;5:3u"},
		{name: "control c", code: "KeyC", text: "c", action: "press", want: "\x1b[99;5u"},
		{name: "control e", code: "KeyE", text: "e", action: "press", want: "\x1b[101;5u"},
		{name: "control k", code: "KeyK", text: "k", action: "press", want: "\x1b[107;5u"},
		{name: "control u", code: "KeyU", text: "u", action: "press", want: "\x1b[117;5u"},
		{name: "control w", code: "KeyW", text: "w", action: "press", want: "\x1b[119;5u"},
		{name: "control z", code: "KeyZ", text: "z", action: "press", want: "\x1b[122;5u"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := engine.EncodeInput(SemanticInput{
				Kind: "key", Code: test.code, Text: test.text, Action: test.action,
				Modifiers: SemanticModifierControl,
			})
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.want {
				t.Fatalf("encoded kitty key = %q, want %q", got, test.want)
			}
		})
	}
}

func TestRealNativeActorClearResetsScreenHistoryAndGraphics(t *testing.T) {
	engine, err := NewNativeSemanticEngine(8, 3)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(4)
	actor, err := NewSessionActor(engine, 8, 3, store)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.Close()
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	if _, err := actor.ApplyPTYOutput([]byte("one\r\ntwo\r\nthree\r\nfour\x1b_Ga=T,f=24,s=1,v=1,i=7,q=2;AQID\x1b\\")); err != nil {
		t.Fatal(err)
	}
	before, ok := store.Latest()
	if !ok || before.Frame.History.TotalRows <= before.Frame.Height || len(before.Frame.Graphics.Images) != 1 {
		t.Fatalf("pre-clear presentation=%+v", before)
	}

	cleared, err := actor.Clear()
	if err != nil {
		t.Fatal(err)
	}
	if cleared.State.ContentEpoch != 1 || cleared.Sequence != before.Sequence+1 {
		t.Fatalf("clear identity=%+v before=%+v", cleared.State, before.State)
	}
	if cleared.Frame.History.TotalRows != cleared.Frame.Height || cleared.Frame.History.ScreenStartOffset != 0 {
		t.Fatalf("clear history=%+v", cleared.Frame.History)
	}
	if len(cleared.Frame.Graphics.Images) != 0 || len(cleared.Frame.Graphics.Placements) != 0 {
		t.Fatalf("clear graphics=%+v", cleared.Frame.Graphics)
	}
	for _, row := range cleared.Frame.Rows {
		for _, cell := range row.Cells {
			if cell.Text != "" && cell.Text != " " {
				t.Fatalf("clear retained cell text %q", cell.Text)
			}
		}
	}
}

func TestSemanticCellWidthRejectsUnknownGhosttyWideValue(t *testing.T) {
	for raw, want := range map[int]uint8{0: 1, 1: 2, 2: 0, 3: 0} {
		got, err := semanticCellWidth(raw)
		if err != nil || got != want {
			t.Fatalf("semanticCellWidth(%d)=(%d, %v), want (%d, nil)", raw, got, err, want)
		}
	}
	if _, err := semanticCellWidth(4); err == nil {
		t.Fatal("unknown Ghostty wide value was accepted")
	}
}

func TestRealNativeActorPreservesIndexedAndRGBColors(t *testing.T) {
	engine, err := NewNativeSemanticEngine(4, 2)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(2)
	actor, err := NewSessionActor(engine, 4, 2, store)
	if err != nil {
		t.Fatal(err)
	}
	defer actor.Close()
	if _, err := actor.ApplyPTYOutput([]byte("\x1b[38;2;1;2;3;41mX\x1b[0m")); err != nil {
		t.Fatal(err)
	}
	presentation, ok := store.Latest()
	if !ok {
		t.Fatal("presentation unavailable")
	}
	style := presentation.Frame.Rows[0].Cells[0].Style
	if style.Foreground != "rgb:010203" || style.Background != "indexed:1" {
		t.Fatalf("style = %+v", style)
	}
}

func TestSessionPTYOutputPublishesNativePresentationAsTheDisplayAuthority(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(4)
	actor, _ := NewSessionActor(engine, 20, 4, store)
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), semanticActor: actor, presentationStore: store, lastAppliedCols: 20, lastAppliedRows: 4, geometryGeneration: 1}
	session.processRawPTYData([]byte("session界"))
	p, ok := session.LatestPresentation()
	if !ok || p.Frame.Rows[0].Cells[7].Text != "界" {
		t.Fatalf("presentation=%+v ok=%v", p, ok)
	}
	session.cleanup()
}

func TestSessionResizeAndInputUseSameNativeActor(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(8)
	actor, _ := NewSessionActor(engine, 20, 4, store)
	var writes [][]byte
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), PTY: &os.File{}, semanticActor: actor, presentationStore: store, lastAppliedCols: 20, lastAppliedRows: 4, geometryGeneration: 1, setPTYSize: func(*os.File, *pty.Winsize) error { return nil }, writePTY: func(data []byte) (int, error) {
		writes = append(writes, append([]byte(nil), data...))
		return len(data), nil
	}}
	if err := session.AttachSemanticView("view", "p", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.ResizePTY(30, 6); err != nil {
		t.Fatal(err)
	}
	if err := session.Interact("view", "p", 1, 0, []byte("echo ok\n")); err != nil {
		t.Fatal(err)
	}
	if len(writes) != 1 || string(writes[0]) != "echo ok\n" {
		t.Fatalf("writes=%q", writes)
	}
	if _, err := actor.ApplyPTYOutput([]byte("ok")); err != nil {
		t.Fatal(err)
	}
	p, _ := store.Latest()
	if p.Geometry.Cols != 30 || p.Frame.Width != 30 {
		t.Fatalf("presentation=%+v", p)
	}
	session.cleanup()
}

func TestSessionResizePublishesPresentationWithCanonicalGeometry(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(8)
	actor, err := NewSessionActor(engine, 20, 4, store)
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		PTY:    &os.File{}, isActive: true, semanticActor: actor, presentationStore: store,
		connections:     map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 20, Rows: 4}},
		lastAppliedCols: 20, lastAppliedRows: 4, geometryGeneration: 1,
		setPTYSize: func(*os.File, *pty.Winsize) error { return nil },
	}
	defer session.cleanup()
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	var presentations []SemanticPresentation
	session.liveAttachments = map[string]liveAttachment{"view": {generation: 1, subscriber: LiveSubscriber{
		OnPresentation: func(p SemanticPresentation) bool {
			presentations = append(presentations, p)
			return true
		},
	}}}
	if _, err := session.ApplyConnectionSize("view", 40, 8); err != nil {
		t.Fatal(err)
	}
	if len(presentations) != 1 {
		t.Fatalf("resize presentation notifications=%d, want 1", len(presentations))
	}
	got := presentations[0]
	canonical := session.CanonicalGeometry()
	if got.Geometry != canonical || got.Frame.Width != 40 || got.Frame.Height != 8 {
		t.Fatalf("resize presentation=%+v frame=%dx%d", got.Geometry, got.Frame.Width, got.Frame.Height)
	}
}

func TestSameSizeReconnectRefreshKeepsOneCanonicalGeometryGeneration(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 5)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(8)
	actor, err := NewSessionActor(engine, 20, 5, store)
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		PTY:    &os.File{}, isActive: true, semanticActor: actor, presentationStore: store,
		connections:     map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 20, Rows: 5}},
		lastAppliedCols: 20, lastAppliedRows: 5, geometryGeneration: 1,
		setPTYSize:       func(*os.File, *pty.Winsize) error { return nil },
		requestPTYRedraw: func(*os.File) error { return nil },
	}
	defer session.cleanup()
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}

	geometry, err := session.ApplyConnectionSizeForAttach("view", 20, 5)
	if err != nil {
		t.Fatal(err)
	}
	presentation, ok := store.Latest()
	if !ok {
		t.Fatal("same-size reconnect did not publish a fresh presentation")
	}
	if presentation.Geometry != geometry {
		t.Fatalf("presentation geometry=%+v, canonical=%+v", presentation.Geometry, geometry)
	}
}

func TestDetachedNativeOutputKeepsLatestPresentationWithoutBackpressure(t *testing.T) {
	engine, err := NewNativeSemanticEngine(20, 4)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPresentationStore(2)
	actor, err := NewSessionActor(engine, 20, 4, store)
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{
		config:        newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		semanticActor: actor, presentationStore: store,
		lastAppliedCols: 20, lastAppliedRows: 4, geometryGeneration: 1,
	}
	defer session.cleanup()
	for index := 0; index < 20; index++ {
		session.processRawPTYData([]byte("x"))
	}
	latest, ok := session.LatestPresentation()
	if !ok || latest.Sequence != 20 {
		t.Fatalf("detached latest presentation=%+v ok=%v", latest, ok)
	}
}
