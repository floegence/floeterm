package terminal

import (
	"bytes"
	"os"
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
