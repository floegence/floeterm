package terminal

import (
	"bytes"
	"os"
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
	if _, err := session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{Direction: HistoryStart, Limit: 3}); err != ErrControllerTransport {
		t.Fatalf("stale transport history error=%v", err)
	}
	page, err := session.ReadSemanticHistory("view", 2, SemanticHistoryRequest{Direction: HistoryStart, Limit: 3})
	if err != nil || page.Frame.Rows[0].Cells[0].Text != "row-0" {
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
	if _, err := session.ReadSemanticHistory("view", 2, SemanticHistoryRequest{Direction: HistoryStart, Limit: 3}); err != ErrControllerTransport {
		t.Fatalf("detached history error=%v", err)
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
		_, _ = session.ReadSemanticHistory("view", 1, SemanticHistoryRequest{Direction: HistoryStart, Limit: 3})
	}()
	<-engine.entered
	outputDone := make(chan struct{})
	go func() { _ = actor.ApplyPTYOutput([]byte("after-history")); close(outputDone) }()
	select {
	case <-outputDone:
		t.Fatal("PTY output entered engine while history query owned the actor")
	default:
	}
	close(engine.release)
	historyWG.Wait()
	<-outputDone
	if got := engine.calls[len(engine.calls)-2:]; got[0] != "apply" || got[1] != "capture" {
		t.Fatalf("actor call order=%v", engine.calls)
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
