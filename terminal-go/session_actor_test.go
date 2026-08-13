package terminal

import (
	"errors"
	"sync"
	"testing"
)

type fakeSemanticEngine struct {
	output []byte
	frame  SemanticFrame
	calls  []string
}

func (e *fakeSemanticEngine) ApplyOutput(data []byte) (TerminalState, error) {
	e.calls = append(e.calls, "apply")
	e.output = append(e.output, data...)
	return TerminalState{Title: "shell"}, nil
}
func (e *fakeSemanticEngine) CaptureFrame() (SemanticFrame, error) {
	e.calls = append(e.calls, "capture")
	return e.frame, nil
}
func (e *fakeSemanticEngine) Resize(c, r int) error { e.calls = append(e.calls, "resize"); return nil }
func (e *fakeSemanticEngine) EncodeInput(i SemanticInput) ([]byte, error) {
	e.calls = append(e.calls, "input")
	if i.Text == "" {
		return nil, errors.New("empty")
	}
	return []byte(i.Text), nil
}
func (e *fakeSemanticEngine) Close() { e.calls = append(e.calls, "close") }

func TestSessionActorAppliesOutputBeforeCapturingAtomicPresentation(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24, Rows: []SemanticRow{{Cells: []SemanticCell{{Text: "界"}}}}}}
	store := NewPresentationStore(2)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.ApplyPTYOutput([]byte("bytes")); err != nil {
		t.Fatal(err)
	}
	if len(engine.calls) != 2 || engine.calls[0] != "apply" || engine.calls[1] != "capture" {
		t.Fatalf("calls=%v", engine.calls)
	}
	p, ok := store.Latest()
	if !ok || p.Sequence != 1 || p.State.Sequence != 1 || p.Geometry.Cols != 80 || p.Frame.Rows[0].Cells[0].Text != "界" {
		t.Fatalf("presentation=%+v", p)
	}
}

func TestSessionActorSerializesResizeAndInputIntent(t *testing.T) {
	engine := &fakeSemanticEngine{}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(1))
	if err := actor.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	var wrote string
	if err := actor.Input(SemanticInput{Kind: "text", Text: "x"}, func(data []byte) error { wrote = string(data); return nil }); err != nil {
		t.Fatal(err)
	}
	if wrote != "x" || len(engine.calls) != 3 || engine.calls[0] != "resize" || engine.calls[1] != "capture" || engine.calls[2] != "input" {
		t.Fatalf("calls=%v wrote=%q", engine.calls, wrote)
	}
}

func TestSessionActorOwnsConcurrentAdmissionSequence(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(64))
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := actor.ApplyPTYOutput([]byte("x")); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if len(engine.output) != 20 {
		t.Fatalf("output bytes=%d", len(engine.output))
	}
}
