//go:build floeterm_native

package terminal

import (
	"os"
	"testing"

	"github.com/creack/pty"
)

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
	if err := actor.ApplyPTYOutput([]byte("\x1b[?1049h\x1b]8;;https://test\x1b\\界e\u0301\x1b]8;;\x1b\\")); err != nil {
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
	if err := actor.ApplyPTYOutput([]byte("x")); err != nil {
		t.Fatal(err)
	}
	latest, _ := store.Latest()
	if latest.Geometry.Cols != 30 || latest.Frame.Width != 30 {
		t.Fatalf("geometry=%+v frame=%dx%d", latest.Geometry, latest.Frame.Width, latest.Frame.Height)
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
	if err := actor.ApplyPTYOutput([]byte("\x1b[38;2;1;2;3;41mX\x1b[0m")); err != nil {
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

func TestSessionPTYOutputPublishesNativePresentationBeforeCompatibilityHistory(t *testing.T) {
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
	if err := actor.ApplyPTYOutput([]byte("ok")); err != nil {
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
	store.Next()
	var presentations []SemanticPresentation
	session.liveAttachments = map[string]liveAttachment{"view": {generation: 1, subscriber: LiveSubscriber{
		OnOutput: func(TerminalOutputEvent) bool { return true },
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
	store.TakeLatest()

	geometry, err := session.ApplyConnectionSizeForAttach("view", 20, 5)
	if err != nil {
		t.Fatal(err)
	}
	presentation, ok := store.TakeLatest()
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
		ringBuffer: NewTerminalRingBuffer(32),
	}
	defer session.cleanup()
	for index := 0; index < 20; index++ {
		session.processRawPTYData([]byte("x"))
	}
	latest, ok := session.LatestPresentation()
	if !ok || latest.Sequence != 20 {
		t.Fatalf("detached latest presentation=%+v ok=%v", latest, ok)
	}
	if _, ok := store.Next(); ok {
		t.Fatal("detached output retained a transport delivery backlog")
	}
}
