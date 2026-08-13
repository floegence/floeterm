package livev1

import (
	"context"
	"errors"
	"testing"

	terminal "github.com/floegence/floeterm/terminal-go"
)

func TestManagerBackendRegistersLiveConnectionBeforeActivation(t *testing.T) {
	manager := terminal.NewManager(terminal.ManagerConfig{Logger: terminal.NopLogger{}})
	session, err := manager.CreateSession("attach-order", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(manager.Cleanup)

	activationObservedConnection := false
	backend := NewManagerBackend(manager, ManagerBackendOptions{
		Activate: func(_ context.Context, sessionID string, cols, rows int) error {
			if sessionID != session.ID {
				t.Fatalf("activation session = %q, want %q", sessionID, session.ID)
			}
			geometry, applyErr := session.ApplyConnectionSize("connection-a", cols, rows)
			if applyErr != nil {
				return applyErr
			}
			activationObservedConnection = geometry.Cols == cols && geometry.Rows == rows
			return nil
		},
	})

	attached, detach, err := backend.Attach(context.Background(), Attach{
		AttachGeneration: 1,
		Cols:             100,
		Rows:             30,
		SessionID:        session.ID,
		ConnectionID:     "connection-a",
	}, Subscriber{OnOutput: func(OutputRecord) bool { return true }})
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	defer detach()

	if !activationObservedConnection {
		t.Fatal("activation started before the live connection dimensions were registered")
	}
	if attached.Cols != 100 || attached.Rows != 30 {
		t.Fatalf("attached geometry = %dx%d", attached.Cols, attached.Rows)
	}
}

func TestManagerBackendDetachesConnectionWhenActivationFails(t *testing.T) {
	manager := terminal.NewManager(terminal.ManagerConfig{Logger: terminal.NopLogger{}})
	session, err := manager.CreateSession("attach-failure", "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(manager.Cleanup)

	backend := NewManagerBackend(manager, ManagerBackendOptions{
		Activate: func(context.Context, string, int, int) error {
			return errors.New("activation failed")
		},
	})
	_, _, err = backend.Attach(context.Background(), Attach{
		AttachGeneration: 1,
		Cols:             100,
		Rows:             30,
		SessionID:        session.ID,
		ConnectionID:     "connection-a",
	}, Subscriber{OnOutput: func(OutputRecord) bool { return true }})
	if !errors.Is(err, ErrActivationFailed) {
		t.Fatalf("attach error = %v", err)
	}
	if _, err := session.ApplyConnectionSize("connection-a", 100, 30); err == nil {
		t.Fatal("failed activation left the live connection attached")
	}
}

func TestManagerBackendObserverResizeDoesNotChangeCanonicalGeometry(t *testing.T) {
	manager := terminal.NewManager(terminal.ManagerConfig{Logger: terminal.NopLogger{}})
	session, err := manager.CreateSession("controller-resize", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Cleanup)
	backend := NewManagerBackend(manager, ManagerBackendOptions{Activate: func(context.Context, string, int, int) error { return nil }})
	_, detachFirst, err := backend.Attach(context.Background(), Attach{AttachGeneration: 1, Cols: 120, Rows: 40, SessionID: session.ID, ConnectionID: "first"}, Subscriber{OnOutput: func(OutputRecord) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	defer detachFirst()
	_, detachSecond, err := backend.Attach(context.Background(), Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: session.ID, ConnectionID: "second"}, Subscriber{OnOutput: func(OutputRecord) bool { return true }})
	if err != nil {
		t.Fatal(err)
	}
	defer detachSecond()
	before := session.CanonicalGeometry()
	got, err := backend.Resize(context.Background(), Attach{AttachGeneration: 1, SessionID: session.ID, ConnectionID: "second"}, Resize{Sequence: 1, Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	after := session.CanonicalGeometry()
	if after != before || int(got.Cols) != before.Cols || int(got.Rows) != before.Rows {
		t.Fatalf("observer changed canonical geometry: before=%+v after=%+v ack=%+v", before, after, got)
	}
}
