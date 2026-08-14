package terminal

import (
	"errors"
	"os"
	"testing"

	"github.com/creack/pty"
)

func newSemanticResizeTestSession(t *testing.T, engine *fakeSemanticEngine) (*Session, *[]SemanticPresentation, *[][2]int) {
	t.Helper()
	store := NewPresentationStore(1)
	actor, err := NewSessionActor(engine, 80, 24, store)
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	presentations := []SemanticPresentation{}
	kernelSizes := [][2]int{}
	session := &Session{
		PTY:                        &os.File{},
		isActive:                   true,
		semanticActor:              actor,
		presentationStore:          store,
		latestPresentationSequence: 1,
		lastAppliedCols:            80,
		lastAppliedRows:            24,
		geometryGeneration:         1,
		connections:                map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		liveAttachments: map[string]liveAttachment{"view": {
			generation: 1,
			subscriber: LiveSubscriber{OnPresentation: func(p SemanticPresentation) bool {
				presentations = append(presentations, p)
				return true
			}},
		}},
		setPTYSize: func(_ *os.File, size *pty.Winsize) error {
			kernelSizes = append(kernelSizes, [2]int{int(size.Cols), int(size.Rows)})
			return nil
		},
		config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	return session, &presentations, &kernelSizes
}

func TestSemanticResizeAcknowledgesExactActorPresentation(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	session, presentations, _ := newSemanticResizeTestSession(t, engine)
	geometry, err := session.ApplySemanticControllerSize("view", 120, 40, false)
	if err != nil {
		t.Fatal(err)
	}
	if geometry.Generation != 2 || geometry.PresentationSequence != 2 || geometry.Cols != 120 || geometry.Rows != 40 {
		t.Fatalf("geometry=%+v", geometry)
	}
	if len(*presentations) != 1 {
		t.Fatalf("presentations=%d, want 1", len(*presentations))
	}
	produced := (*presentations)[0]
	if produced.Sequence != geometry.PresentationSequence || produced.Geometry != geometry || produced.Frame.Width != 120 || produced.Frame.Height != 40 {
		t.Fatalf("presentation=%+v geometry=%+v", produced, geometry)
	}
}

func TestSemanticResizeCaptureFailureRollsBackWithoutAcknowledgement(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	session, presentations, kernelSizes := newSemanticResizeTestSession(t, engine)
	engine.captureErr = errors.New("capture failed")
	if _, err := session.ApplySemanticControllerSize("view", 120, 40, false); err == nil {
		t.Fatal("resize unexpectedly succeeded")
	}
	if len(*presentations) != 0 {
		t.Fatalf("failed resize broadcast %d presentations", len(*presentations))
	}
	if got := session.CanonicalGeometry(); got.Generation != 1 || got.PresentationSequence != 1 || got.Cols != 80 || got.Rows != 24 {
		t.Fatalf("canonical geometry changed after failure: %+v", got)
	}
	if len(*kernelSizes) != 2 || (*kernelSizes)[0] != [2]int{120, 40} || (*kernelSizes)[1] != [2]int{80, 24} {
		t.Fatalf("kernel resize/rollback=%v", *kernelSizes)
	}
}

func TestSemanticResizeFailsClosedWithoutActor(t *testing.T) {
	session := &Session{
		PTY:             &os.File{},
		isActive:        true,
		connections:     map[string]*ConnectionInfo{"view": {ConnID: "view", Cols: 80, Rows: 24}},
		liveAttachments: make(map[string]liveAttachment),
		config:          newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}
	if _, err := session.ApplySemanticControllerSize("view", 120, 40, false); err == nil {
		t.Fatal("semantic resize acknowledged without an actor")
	}
}
