package livev1

import (
	"context"
	"net"
	"testing"
	"time"
)

type semanticBackend struct{ subscriber Subscriber }

func (b *semanticBackend) Attach(_ context.Context, _ Attach, subscriber Subscriber) (Attached, func(), error) {
	b.subscriber = subscriber
	return Attached{PresentationSequence: 1, GeometryGeneration: 1, Cols: 80, Rows: 24}, func() {}, nil
}

func (*semanticBackend) WriteInput(context.Context, Attach, Input) error { return nil }
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
