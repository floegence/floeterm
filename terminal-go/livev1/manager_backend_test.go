//go:build floeterm_native

package livev1

import (
	"context"
	"encoding/json"
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
	}, Subscriber{})
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
	}, Subscriber{})
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
	_, detachFirst, err := backend.Attach(context.Background(), Attach{AttachGeneration: 1, Cols: 120, Rows: 40, SessionID: session.ID, ConnectionID: "first"}, Subscriber{})
	if err != nil {
		t.Fatal(err)
	}
	defer detachFirst()
	controllerGeometry := session.CanonicalGeometry()
	_, detachSecond, err := backend.Attach(context.Background(), Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: session.ID, ConnectionID: "second"}, Subscriber{})
	if err != nil {
		t.Fatal(err)
	}
	defer detachSecond()
	before := session.CanonicalGeometry()
	if before != controllerGeometry {
		t.Fatalf("observer attach changed canonical geometry: controller=%+v after=%+v", controllerGeometry, before)
	}
	got, err := backend.Resize(context.Background(), Attach{AttachGeneration: 1, SessionID: session.ID, ConnectionID: "second"}, Resize{Sequence: 1, Cols: 60, Rows: 20})
	if err != nil {
		t.Fatal(err)
	}
	after := session.CanonicalGeometry()
	if after != before || int(got.Cols) != before.Cols || int(got.Rows) != before.Rows {
		t.Fatalf("observer changed canonical geometry: before=%+v after=%+v ack=%+v", before, after, got)
	}
	detachSecond()
	if afterDetach := session.CanonicalGeometry(); afterDetach != before {
		t.Fatalf("observer detach changed canonical geometry: before=%+v after=%+v", before, afterDetach)
	}
}

func TestManagerBackendExplicitActivationTransfersControllerAndViewport(t *testing.T) {
	manager := terminal.NewManager(terminal.ManagerConfig{Logger: terminal.NopLogger{}})
	session, err := manager.CreateSession("explicit-activation", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Cleanup)
	backend := NewManagerBackend(manager, ManagerBackendOptions{})
	activityAttached, detachActivity, err := backend.Attach(context.Background(), Attach{
		AttachGeneration: 1, Cols: 46, Rows: 16,
		SessionID: session.ID, ConnectionID: "activity",
	}, Subscriber{})
	if err != nil {
		t.Fatal(err)
	}
	defer detachActivity()
	var workbenchPresentations []struct {
		Sequence uint64                    `json:"sequence"`
		Geometry terminal.TerminalGeometry `json:"geometry"`
		Frame    struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"frame"`
	}
	attached, detachWorkbench, err := backend.Attach(context.Background(), Attach{
		AttachGeneration: 7, Cols: 120, Rows: 40,
		SessionID: session.ID, ConnectionID: "workbench",
	}, Subscriber{OnPresentation: func(data []byte) bool {
		var presentation struct {
			Sequence uint64                    `json:"sequence"`
			Geometry terminal.TerminalGeometry `json:"geometry"`
			Frame    struct {
				Width  int `json:"width"`
				Height int `json:"height"`
			} `json:"frame"`
		}
		if decodeErr := json.Unmarshal(data, &presentation); decodeErr != nil {
			t.Errorf("decode presentation: %v", decodeErr)
			return false
		}
		workbenchPresentations = append(workbenchPresentations, presentation)
		return true
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer detachWorkbench()
	if attached.IsController || attached.Cols != 46 || attached.Rows != 16 {
		t.Fatalf("observer attached=%+v", attached)
	}
	observerResize, err := backend.Resize(context.Background(), Attach{
		AttachGeneration: 7, SessionID: session.ID, ConnectionID: "workbench",
	}, Resize{Sequence: 1, Cols: 110, Rows: 35})
	if err != nil {
		t.Fatal(err)
	}
	if observerResize.Cols != 46 || observerResize.Rows != 16 {
		t.Fatalf("observer resize changed canonical geometry=%+v", observerResize)
	}
	if err := backend.WriteInput(context.Background(), Attach{
		AttachGeneration: 7, SessionID: session.ID, ConnectionID: "workbench",
	}, Input{Sequence: 1, Data: []byte("x")}); err != nil {
		t.Fatal(err)
	}
	if geometry := session.CanonicalGeometry(); geometry.Cols != 110 || geometry.Rows != 35 {
		t.Fatalf("input activation geometry=%+v", geometry)
	}
	if controller := session.Controller(); controller.AttachmentID != "workbench" || controller.Epoch != attached.ControllerEpoch+1 {
		t.Fatalf("input activation controller=%+v", controller)
	}
	activityActivated, err := backend.Activate(context.Background(), Attach{
		AttachGeneration: 1, SessionID: session.ID, ConnectionID: "activity",
	}, Activate{Sequence: 1, ControllerEpoch: session.Controller().Epoch, Cols: 46, Rows: 16})
	if err != nil {
		t.Fatal(err)
	}
	if activityActivated.ControllerEpoch <= activityAttached.ControllerEpoch || activityActivated.Cols != 46 || activityActivated.Rows != 16 {
		t.Fatalf("Activity reactivation=%+v", activityActivated)
	}

	activated, err := backend.Activate(context.Background(), Attach{
		AttachGeneration: 7, SessionID: session.ID, ConnectionID: "workbench",
	}, Activate{Sequence: 2, ControllerEpoch: session.Controller().Epoch, Cols: 120, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}
	if activated.ControllerEpoch != activityActivated.ControllerEpoch+1 || activated.Cols != 120 || activated.Rows != 40 {
		t.Fatalf("activated=%+v", activated)
	}
	controller := session.Controller()
	if controller.AttachmentID != "workbench" || controller.TransportGeneration != 7 || controller.Epoch != activated.ControllerEpoch {
		t.Fatalf("controller=%+v", controller)
	}
	if len(workbenchPresentations) == 0 {
		t.Fatal("activation did not broadcast a Presentation")
	}
	var activationPresentation *struct {
		Sequence uint64                    `json:"sequence"`
		Geometry terminal.TerminalGeometry `json:"geometry"`
		Frame    struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"frame"`
	}
	for index := range workbenchPresentations {
		if workbenchPresentations[index].Sequence == activated.PresentationSequence {
			activationPresentation = &workbenchPresentations[index]
		}
	}
	if activationPresentation == nil || activationPresentation.Geometry.Cols != 120 || activationPresentation.Geometry.Rows != 40 ||
		activationPresentation.Frame.Width != 120 || activationPresentation.Frame.Height != 40 {
		t.Fatalf("activation presentation=%+v", activationPresentation)
	}
}

func TestManagerBackendRejectsSupersededInputGenerationWithoutPTYWrite(t *testing.T) {
	manager := terminal.NewManager(terminal.ManagerConfig{Logger: terminal.NopLogger{}})
	session, err := manager.CreateSession("stale-input-generation", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Cleanup)
	backend := NewManagerBackend(manager, ManagerBackendOptions{})
	_, detachFirst, err := backend.Attach(context.Background(), Attach{
		AttachGeneration: 1, Cols: 80, Rows: 24,
		SessionID: session.ID, ConnectionID: "view",
	}, Subscriber{})
	if err != nil {
		t.Fatal(err)
	}
	defer detachFirst()
	_, detachSecond, err := backend.Attach(context.Background(), Attach{
		AttachGeneration: 2, Cols: 80, Rows: 24,
		SessionID: session.ID, ConnectionID: "view",
	}, Subscriber{})
	if err != nil {
		t.Fatal(err)
	}
	defer detachSecond()
	before := session.Controller()
	if err := backend.WriteInput(context.Background(), Attach{
		AttachGeneration: 1, SessionID: session.ID, ConnectionID: "view",
	}, Input{Sequence: 1, Data: []byte("must-not-write")}); !errors.Is(err, terminal.ErrControllerTransport) {
		t.Fatalf("stale input error=%v", err)
	}
	if session.Controller() != before {
		t.Fatalf("stale input changed controller: before=%+v after=%+v", before, session.Controller())
	}
}
