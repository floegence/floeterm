package livev1

import (
	"context"
	"net"
	"testing"
	"time"
)

type semanticBackend struct {
	subscriber Subscriber
	inputs     []Input
	intents    []InputIntent
}

func (b *semanticBackend) Attach(_ context.Context, _ Attach, subscriber Subscriber) (Attached, func(), error) {
	b.subscriber = subscriber
	return Attached{PresentationSequence: 1, GeometryGeneration: 1, Cols: 80, Rows: 24}, func() {}, nil
}

func (b *semanticBackend) WriteInput(_ context.Context, _ Attach, input Input) error {
	b.inputs = append(b.inputs, input)
	return nil
}
func (b *semanticBackend) WriteInputIntent(_ context.Context, _ Attach, input InputIntent) error {
	b.intents = append(b.intents, input)
	return nil
}
func (*semanticBackend) Resize(_ context.Context, _ Attach, resize Resize) (EffectiveGeometry, error) {
	return EffectiveGeometry{Generation: 2, PresentationSequence: 2, Cols: resize.Cols, Rows: resize.Rows}, nil
}

func TestServiceWritesSemanticPresentationWithoutRawOutput(t *testing.T) {
	backend := &semanticBackend{}
	server, client := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- NewService(backend).Serve(context.Background(), server) }()

	attach, err := EncodeAttach(Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: "session", ConnectionID: "view"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(attach); err != nil {
		t.Fatal(err)
	}
	if frame, err := ReadFrame(client); err != nil || frame.Type != FrameAttached {
		t.Fatalf("attached frame = %+v, err = %v", frame, err)
	}
	if !backend.subscriber.OnPresentation([]byte(`{"v":1,"sequence":1}`)) {
		t.Fatal("presentation was not admitted")
	}
	if frame, err := ReadFrame(client); err != nil || frame.Type != FramePresentation {
		t.Fatalf("presentation frame = %+v, err = %v", frame, err)
	}
	detach, _ := EncodeFrame(Frame{Type: FrameDetach})
	_, _ = client.Write(detach)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("service did not stop")
	}
}

func TestServiceAdmitsOrderedTextAndStructuredInputOnOneSequence(t *testing.T) {
	backend := &semanticBackend{}
	server, client := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- NewService(backend).Serve(context.Background(), server) }()

	attach, _ := EncodeAttach(Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: "session", ConnectionID: "view"})
	_, _ = client.Write(attach)
	if _, err := ReadFrame(client); err != nil {
		t.Fatal(err)
	}
	textInput, _ := EncodeInput(Input{Sequence: 1, Data: []byte("x")})
	intentInput, _ := EncodeInputIntent(InputIntent{Sequence: 2, Code: "Enter", Action: KeyActionPress})
	_, _ = client.Write(textInput)
	_, _ = client.Write(intentInput)
	detach, _ := EncodeFrame(Frame{Type: FrameDetach})
	_, _ = client.Write(detach)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("service did not stop")
	}
	if len(backend.inputs) != 1 || string(backend.inputs[0].Data) != "x" || len(backend.intents) != 1 || backend.intents[0].Code != "Enter" {
		t.Fatalf("text=%+v intents=%+v", backend.inputs, backend.intents)
	}
}
