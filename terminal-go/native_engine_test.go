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
