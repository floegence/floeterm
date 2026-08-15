package terminal

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestInteractRejectsStaleTransportEpochAndCrossPrincipalWithoutWrite(t *testing.T) {
	var writes [][]byte
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), PTY: &os.File{}, writePTY: func(data []byte) (int, error) {
		writes = append(writes, append([]byte(nil), data...))
		return len(data), nil
	}}
	if err := session.AttachSemanticView("a", "principal", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.Interact("a", "principal", 1, 0, []byte("first")); err != nil {
		t.Fatal(err)
	}
	state := session.Controller()
	if state.Epoch != 1 || len(writes) != 1 || !bytes.Equal(writes[0], []byte("first")) {
		t.Fatalf("state=%+v writes=%q", state, writes)
	}
	if err := session.Interact("a", "principal", 2, state.Epoch, []byte("old")); err != ErrControllerTransport {
		t.Fatalf("old transport err=%v", err)
	}
	if err := session.AttachSemanticView("b", "other", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.Interact("b", "other", 1, state.Epoch, []byte("cross")); err != ErrControllerPrincipal {
		t.Fatalf("cross principal err=%v", err)
	}
	if len(writes) != 1 {
		t.Fatalf("rejected interactions wrote %d times", len(writes))
	}
}

func TestStructuredKeyInputUsesActorEncoderAndRejectsStaleTransport(t *testing.T) {
	engine := &fakeSemanticEngine{}
	actor, err := NewSessionActor(engine, 80, 24, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	var writes [][]byte
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), PTY: &os.File{}, semanticActor: actor, writePTY: func(data []byte) (int, error) {
		writes = append(writes, append([]byte(nil), data...))
		return len(data), nil
	}}
	if err := session.AttachSemanticView("view", "principal", 3); err != nil {
		t.Fatal(err)
	}
	intent := SemanticInput{Kind: "key", Code: "Enter", Text: "encoded-enter", Action: "press"}
	if err := session.InteractSemantic("view", "principal", 3, 0, intent); err != nil {
		t.Fatal(err)
	}
	if len(writes) != 1 || string(writes[0]) != "encoded-enter" || engine.calls[len(engine.calls)-1] != "input" {
		t.Fatalf("writes=%q calls=%v", writes, engine.calls)
	}
	if err := session.InteractSemantic("view", "principal", 2, session.Controller().Epoch, intent); err != ErrControllerTransport {
		t.Fatalf("stale structured input error=%v", err)
	}
	if len(writes) != 1 {
		t.Fatalf("stale structured input wrote %d times", len(writes))
	}
}

func TestFramedByteInputPreservesSplitUTF8ThroughActor(t *testing.T) {
	engine := &fakeSemanticEngine{}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(1))
	var wrote []byte
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), PTY: &os.File{}, semanticActor: actor, writePTY: func(data []byte) (int, error) {
		wrote = append(wrote, data...)
		return len(data), nil
	}}
	if err := session.AttachSemanticView("view", "principal", 1); err != nil {
		t.Fatal(err)
	}
	for index, fragment := range [][]byte{{0xf0, 0x9f}, {0x98, 0x80}} {
		epoch := uint64(0)
		if index > 0 {
			epoch = session.Controller().Epoch
		}
		if err := session.Interact("view", "principal", 1, epoch, fragment); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(wrote, []byte("😀")) {
		t.Fatalf("split UTF-8 bytes = %x", wrote)
	}
}

func TestFailedStructuredInputDoesNotTransferController(t *testing.T) {
	engine := &fakeSemanticEngine{}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(1))
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), PTY: &os.File{}, semanticActor: actor, writePTY: func(data []byte) (int, error) {
		return len(data), nil
	}}
	if err := session.AttachSemanticView("first", "principal", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.Interact("first", "principal", 1, 0, []byte("first")); err != nil {
		t.Fatal(err)
	}
	before := session.Controller()
	if err := session.AttachSemanticView("second", "principal", 1); err != nil {
		t.Fatal(err)
	}
	err := session.InteractSemantic("second", "principal", 1, before.Epoch, SemanticInput{Kind: "key", Code: "Enter", Action: "press"})
	if err == nil {
		t.Fatal("invalid structured input was accepted")
	}
	if after := session.Controller(); after != before {
		t.Fatalf("failed input changed controller: before=%+v after=%+v", before, after)
	}
}

func TestZeroByteStructuredInputDoesNotTransferControllerOrWrite(t *testing.T) {
	engine := &fakeSemanticEngine{emptyInput: true}
	actor, _ := NewSessionActor(engine, 80, 24, NewPresentationStore(1))
	writes := 0
	session := &Session{config: newSessionConfig(ManagerConfig{Logger: NopLogger{}}), PTY: &os.File{}, semanticActor: actor, writePTY: func(data []byte) (int, error) {
		writes++
		return len(data), nil
	}}
	if err := session.AttachSemanticView("observer", "principal", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.InteractSemantic("observer", "principal", 1, 0, SemanticInput{
		Kind: "key", Code: "Enter", Action: "release",
	}); err != nil {
		t.Fatal(err)
	}
	if state := session.Controller(); state.AttachmentID != "" || state.Epoch != 0 {
		t.Fatalf("zero-byte input transferred controller: %+v", state)
	}
	if writes != 0 {
		t.Fatalf("zero-byte input wrote %d times", writes)
	}
}

func TestSemanticDetachRequiresCurrentTransportGeneration(t *testing.T) {
	session := &Session{}
	if err := session.AttachSemanticView("view", "principal", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.AttachSemanticView("view", "principal", 2); err != nil {
		t.Fatal(err)
	}
	if session.LogicalDetachSemanticView("view", 1) {
		t.Fatal("old transport detached current view")
	}
	if !session.LogicalDetachSemanticView("view", 2) {
		t.Fatal("current transport did not detach")
	}
}

func TestSamePrincipalObserverFirstInputTakesControlAndWritesOnce(t *testing.T) {
	var writes [][]byte
	session := &Session{PTY: &os.File{}, writePTY: func(data []byte) (int, error) {
		writes = append(writes, append([]byte(nil), data...))
		return len(data), nil
	}}
	if err := session.AttachSemanticView("a", "principal", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.Interact("a", "principal", 1, 0, []byte("a")); err != nil {
		t.Fatal(err)
	}
	epoch := session.Controller().Epoch
	if err := session.AttachSemanticView("b", "principal", 7); err != nil {
		t.Fatal(err)
	}
	if err := session.Interact("b", "principal", 7, epoch, []byte("b")); err != nil {
		t.Fatal(err)
	}
	state := session.Controller()
	if state.AttachmentID != "b" || state.TransportGeneration != 7 || state.Epoch != epoch+1 {
		t.Fatalf("controller=%+v", state)
	}
	if len(writes) != 2 || string(writes[1]) != "b" {
		t.Fatalf("writes=%q", writes)
	}
}

func TestSemanticHistoryRequiresCurrentAttachmentAndReleasesOnDetach(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 8}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{semanticActor: actor}
	if err := session.AttachSemanticView("view", "principal", 2); err != nil {
		t.Fatal(err)
	}
	if _, err := session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{Direction: HistoryStart, ViewportRows: 3}); err != ErrControllerTransport {
		t.Fatalf("stale transport history error=%v", err)
	}
	page, err := session.ReadSemanticHistory("view", 2, SemanticHistoryRequest{Direction: HistoryStart, ViewportRows: 3})
	if err != nil || historyChunkFirstText(t, page) != "row-0" || page.TransportGeneration != 2 {
		t.Fatalf("semantic history page=%+v error=%v", page, err)
	}
	if !session.LogicalDetachSemanticView("view", 2) {
		t.Fatal("current attachment did not detach")
	}
	for _, anchor := range engine.anchors {
		if !anchor.closed {
			t.Fatal("detach retained native history anchor")
		}
	}
	if _, err := session.ReadSemanticHistory("view", 2, SemanticHistoryRequest{Direction: HistoryStart, ViewportRows: 3}); err != ErrControllerTransport {
		t.Fatalf("detached history error=%v", err)
	}
}

func TestSemanticClearRequiresCurrentTransportAndAtomicallyTransfersSamePrincipalController(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{
		Width: 8, Height: 3, BufferKind: "normal",
		Rows: make([]SemanticRow, 3), Cursor: SemanticCursor{Shape: "block"},
		History: SemanticHistorySummary{TotalRows: 3}, Graphics: SemanticGraphics{},
	}}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(2))
	if err != nil {
		t.Fatal(err)
	}
	if err := actor.PublishInitialPresentation(); err != nil {
		t.Fatal(err)
	}
	var firstView, secondView []SemanticPresentation
	session := &Session{
		semanticActor: actor,
		semanticAttachments: map[string]SemanticAttachment{
			"first":  {PrincipalID: "person", TransportGeneration: 1},
			"second": {PrincipalID: "person", TransportGeneration: 7},
			"other":  {PrincipalID: "other", TransportGeneration: 3},
		},
		controllerState: ControllerState{AttachmentID: "first", PrincipalID: "person", TransportGeneration: 1, Epoch: 4},
		liveAttachments: map[string]liveAttachment{
			"first":  {generation: 1, subscriber: LiveSubscriber{OnPresentation: func(p SemanticPresentation) bool { firstView = append(firstView, p); return true }}},
			"second": {generation: 7, subscriber: LiveSubscriber{OnPresentation: func(p SemanticPresentation) bool { secondView = append(secondView, p); return true }}},
		},
		latestPresentationSequence: 1,
		geometryGeneration:         1,
		lastAppliedCols:            8,
		lastAppliedRows:            3,
	}

	if _, err := session.ClearSemanticScreen("first", "person", 2); !errors.Is(err, ErrControllerTransport) {
		t.Fatalf("stale clear error=%v", err)
	}
	if engine.resetCount != 0 {
		t.Fatalf("stale clear reset engine %d times", engine.resetCount)
	}
	if _, err := session.ClearSemanticScreen("other", "other", 3); !errors.Is(err, ErrControllerPrincipal) {
		t.Fatalf("cross-principal clear error=%v", err)
	}
	if engine.resetCount != 0 {
		t.Fatalf("cross-principal clear reset engine %d times", engine.resetCount)
	}

	presentation, err := session.ClearSemanticScreen("second", "person", 7)
	if err != nil {
		t.Fatal(err)
	}
	if engine.resetCount != 1 || presentation.State.ContentEpoch != 1 || presentation.Sequence != 2 {
		t.Fatalf("clear presentation=%+v resetCount=%d", presentation, engine.resetCount)
	}
	controller := session.Controller()
	if controller.AttachmentID != "second" || controller.TransportGeneration != 7 || controller.Epoch != 5 {
		t.Fatalf("controller after clear=%+v", controller)
	}
	if len(firstView) != 1 || len(secondView) != 1 || firstView[0].Sequence != 2 || secondView[0].Sequence != 2 {
		t.Fatalf("clear broadcasts first=%+v second=%+v", firstView, secondView)
	}
}

func TestSemanticClearFailureDoesNotTransferControllerAndFailsClosed(t *testing.T) {
	engine := &fakeSemanticEngine{
		frame:    SemanticFrame{Width: 8, Height: 3, Rows: make([]SemanticRow, 3)},
		resetErr: errors.New("reset failed"),
	}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(2))
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{
		config:        newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
		semanticActor: actor,
		semanticAttachments: map[string]SemanticAttachment{
			"first":  {PrincipalID: "person", TransportGeneration: 1},
			"second": {PrincipalID: "person", TransportGeneration: 2},
		},
		controllerState: ControllerState{AttachmentID: "first", PrincipalID: "person", TransportGeneration: 1, Epoch: 4},
	}
	if _, err := session.ClearSemanticScreen("second", "person", 2); err == nil || !strings.Contains(err.Error(), "reset failed") {
		t.Fatalf("clear error=%v", err)
	}
	if controller := session.Controller(); controller.AttachmentID != "first" || controller.Epoch != 4 {
		t.Fatalf("failed clear transferred controller=%+v", controller)
	}
	if !session.closed || !session.outputClosed || engine.resetCount != 0 {
		t.Fatalf("failed clear state closed=%v outputClosed=%v resetCount=%d", session.closed, session.outputClosed, engine.resetCount)
	}
}

func TestSemanticViewActivationAtomicallyTransfersControllerAndAppliesViewport(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	session, _, _ := newSemanticResizeTestSession(t, engine)
	if _, err := session.ApplySemanticControllerSize("view", 46, 16, false); err != nil {
		t.Fatalf("establish Activity geometry: %v", err)
	}
	if err := session.AttachSemanticView("activity", "person", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.AttachSemanticView("workbench", "person", 7); err != nil {
		t.Fatal(err)
	}
	session.EnsureSemanticController("activity", "person", 1)
	session.RegisterSemanticView("activity", 46, 16)
	session.RegisterSemanticView("workbench", 120, 40)

	presentation, controller, err := session.ActivateSemanticView(
		"workbench", "person", 7, 1, 120, 40,
	)
	if err != nil {
		t.Fatalf("activate Workbench: %v", err)
	}
	if controller.AttachmentID != "workbench" || controller.TransportGeneration != 7 || controller.Epoch != 2 {
		t.Fatalf("controller after activation=%+v", controller)
	}
	geometry := session.CanonicalGeometry()
	if geometry.Cols != 120 || geometry.Rows != 40 {
		t.Fatalf("canonical geometry=%+v", geometry)
	}
	if presentation.Geometry != geometry || presentation.Frame.Width != 120 || presentation.Frame.Height != 40 {
		t.Fatalf("activation presentation=%+v frame=%dx%d canonical=%+v", presentation.Geometry, presentation.Frame.Width, presentation.Frame.Height, geometry)
	}

	before := session.Controller()
	beforeGeometry := session.CanonicalGeometry()
	if _, _, err := session.ActivateSemanticView("workbench", "person", 6, 2, 80, 24); !errors.Is(err, ErrControllerTransport) {
		t.Fatalf("stale transport error=%v", err)
	}
	if _, _, err := session.ActivateSemanticView("activity", "person", 1, 1, 46, 16); !errors.Is(err, ErrControllerEpoch) {
		t.Fatalf("stale epoch error=%v", err)
	}
	if err := session.AttachSemanticView("other", "other", 9); err != nil {
		t.Fatal(err)
	}
	session.RegisterSemanticView("other", 80, 24)
	if _, _, err := session.ActivateSemanticView("other", "other", 9, 2, 80, 24); !errors.Is(err, ErrControllerPrincipal) {
		t.Fatalf("cross-principal error=%v", err)
	}
	if session.Controller() != before || session.CanonicalGeometry() != beforeGeometry {
		t.Fatalf("rejected activation mutated state: controller=%+v geometry=%+v", session.Controller(), session.CanonicalGeometry())
	}
}

func TestSemanticViewActivationFailureRollsBackGeometryWithoutTransferringController(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	session, _, _ := newSemanticResizeTestSession(t, engine)
	if err := session.AttachSemanticView("activity", "person", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.AttachSemanticView("workbench", "person", 7); err != nil {
		t.Fatal(err)
	}
	session.EnsureSemanticController("activity", "person", 1)
	session.RegisterSemanticView("activity", 80, 24)
	session.RegisterSemanticView("workbench", 120, 40)
	beforeController := session.Controller()
	beforeGeometry := session.CanonicalGeometry()
	engine.captureErr = errors.New("capture failed")

	if _, _, err := session.ActivateSemanticView("workbench", "person", 7, beforeController.Epoch, 120, 40); err == nil || !strings.Contains(err.Error(), "capture failed") {
		t.Fatalf("activation error=%v", err)
	}
	if controller := session.Controller(); controller != beforeController {
		t.Fatalf("failed activation transferred controller: before=%+v after=%+v", beforeController, controller)
	}
	if geometry := session.CanonicalGeometry(); geometry != beforeGeometry {
		t.Fatalf("failed activation changed canonical geometry: before=%+v after=%+v", beforeGeometry, geometry)
	}
	if engine.frame.Width != beforeGeometry.Cols || engine.frame.Height != beforeGeometry.Rows {
		t.Fatalf("failed activation left engine at %dx%d", engine.frame.Width, engine.frame.Height)
	}
}

func TestSemanticViewInputActivatesRecordedViewportBeforePTYWrite(t *testing.T) {
	engine := &fakeSemanticEngine{frame: SemanticFrame{Width: 80, Height: 24}}
	session, presentations, _ := newSemanticResizeTestSession(t, engine)
	if err := session.AttachSemanticView("activity", "person", 1); err != nil {
		t.Fatal(err)
	}
	if err := session.AttachSemanticView("workbench", "person", 7); err != nil {
		t.Fatal(err)
	}
	session.EnsureSemanticController("activity", "person", 1)
	session.RegisterSemanticView("activity", 46, 16)
	session.RegisterSemanticView("workbench", 120, 40)
	engine.calls = nil
	var written []byte
	var writeGeometry [2]int
	session.writePTY = func(data []byte) (int, error) {
		written = append(written, data...)
		writeGeometry = [2]int{engine.frame.Width, engine.frame.Height}
		return len(data), nil
	}

	if err := session.InteractSemanticView(
		"workbench", "person", 7, SemanticInput{Kind: "bytes", Data: []byte("x")},
	); err != nil {
		t.Fatal(err)
	}
	if string(written) != "x" || writeGeometry != [2]int{120, 40} {
		t.Fatalf("write=%q geometry-at-write=%v", written, writeGeometry)
	}
	if got := engine.calls; len(got) < 3 || got[0] != "resize" || got[1] != "capture" || got[2] != "input" {
		t.Fatalf("actor order=%v", got)
	}
	controller := session.Controller()
	if controller.AttachmentID != "workbench" || controller.TransportGeneration != 7 || controller.Epoch != 2 {
		t.Fatalf("controller=%+v", controller)
	}
	geometry := session.CanonicalGeometry()
	if geometry.Cols != 120 || geometry.Rows != 40 || len(*presentations) != 1 || (*presentations)[0].Geometry != geometry {
		t.Fatalf("geometry=%+v presentations=%+v", geometry, *presentations)
	}

	before := session.Controller()
	beforeGeometry := session.CanonicalGeometry()
	if err := session.InteractSemanticView("activity", "person", 2, SemanticInput{Kind: "bytes", Data: []byte("stale")}); !errors.Is(err, ErrControllerTransport) {
		t.Fatalf("stale transport error=%v", err)
	}
	if err := session.AttachSemanticView("other", "other", 9); err != nil {
		t.Fatal(err)
	}
	session.RegisterSemanticView("other", 80, 24)
	if err := session.InteractSemanticView("other", "other", 9, SemanticInput{Kind: "bytes", Data: []byte("foreign")}); !errors.Is(err, ErrControllerPrincipal) {
		t.Fatalf("cross-principal error=%v", err)
	}
	if session.Controller() != before || session.CanonicalGeometry() != beforeGeometry || string(written) != "x" {
		t.Fatalf("rejected input mutated state controller=%+v geometry=%+v write=%q", session.Controller(), session.CanonicalGeometry(), written)
	}
}

func TestSemanticHistorySerializesWithPTYOutput(t *testing.T) {
	engine := &blockingSemanticHistoryEngine{
		fakeSemanticHistoryEngine: fakeSemanticHistoryEngine{totalRows: 8},
		entered:                   make(chan struct{}),
		release:                   make(chan struct{}),
	}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, _ := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	session := &Session{semanticActor: actor}
	if err := session.AttachSemanticView("view", "principal", 1); err != nil {
		t.Fatal(err)
	}
	var historyWG sync.WaitGroup
	historyWG.Add(1)
	go func() {
		defer historyWG.Done()
		_, _ = session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{Direction: HistoryStart, ViewportRows: 3})
	}()
	<-engine.entered
	outputDone := make(chan struct{})
	go func() { _, _ = actor.ApplyPTYOutput([]byte("after-history")); close(outputDone) }()
	select {
	case <-outputDone:
		t.Fatal("PTY output entered engine while history query owned the actor")
	default:
	}
	close(engine.release)
	historyWG.Wait()
	<-outputDone
	got := strings.Join(engine.calls, ",")
	if strings.Index(got, "history-read") < 0 || strings.Index(got, "apply") <= strings.Index(got, "history-read") || !strings.Contains(got, "apply,capture") {
		t.Fatalf("actor call order=%v", engine.calls)
	}
}

func TestSemanticHistorySearchAndViewportLanesOwnIndependentBoundedFrontiers(t *testing.T) {
	engine := &fakeSemanticHistoryEngine{totalRows: 12}
	engine.frame = SemanticFrame{Width: 8, Height: 3}
	actor, err := NewSessionActor(engine, 8, 3, NewPresentationStore(1))
	if err != nil {
		t.Fatal(err)
	}
	session := &Session{semanticActor: actor}
	if err := session.AttachSemanticView("view", "principal", 1); err != nil {
		t.Fatal(err)
	}
	viewport, err := session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{
		Lane: HistoryViewportLane, Direction: HistoryEnd, ViewportRows: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	search, err := session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{
		Lane: HistorySearchLane, Direction: HistoryStart, ViewportRows: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if viewport.Anchor == search.Anchor || viewport.Lane != HistoryViewportLane || search.Lane != HistorySearchLane {
		t.Fatalf("history lanes are not isolated: viewport=%+v search=%+v", viewport, search)
	}
	target := viewport.Offset - 1
	if _, err := session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{
		Lane: HistoryViewportLane, Anchor: viewport.Anchor, SnapshotID: viewport.SnapshotID,
		Direction: HistoryBackward, Offset: viewport.Offset, TargetOffset: &target, ViewportRows: 3,
	}); err != nil {
		t.Fatalf("search replaced viewport frontier: %v", err)
	}
	if !session.LogicalDetachSemanticView("view", 1) {
		t.Fatal("semantic view did not detach")
	}
	for _, anchor := range engine.anchors {
		if !anchor.closed || anchor.closeCount != 1 {
			t.Fatalf("detach anchor state=%+v, want exactly one close", anchor)
		}
	}
}

type blockingSemanticHistoryEngine struct {
	fakeSemanticHistoryEngine
	entered chan struct{}
	release chan struct{}
}

func (e *blockingSemanticHistoryEngine) ReadHistory(anchor SemanticHistoryAnchor, limit int) (SemanticFrame, AnchorStatus, error) {
	close(e.entered)
	<-e.release
	return e.fakeSemanticHistoryEngine.ReadHistory(anchor, limit)
}
