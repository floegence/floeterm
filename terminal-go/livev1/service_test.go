package livev1

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

type semanticBackend struct {
	subscriber            Subscriber
	inputs                []Input
	intents               []InputIntent
	pastes                []PasteInput
	activations           []Activate
	rejectFirstActivation bool
}

func (b *semanticBackend) Attach(_ context.Context, _ Attach, subscriber Subscriber) (Attached, func(), error) {
	b.subscriber = subscriber
	return Attached{PresentationSequence: 1, GeometryGeneration: 1, ControllerEpoch: 1, Cols: 80, Rows: 24, IsController: true}, func() {}, nil
}

func (b *semanticBackend) WriteInput(_ context.Context, _ Attach, input Input) error {
	b.inputs = append(b.inputs, input)
	return nil
}
func (b *semanticBackend) WriteInputIntent(_ context.Context, _ Attach, input InputIntent) error {
	b.intents = append(b.intents, input)
	return nil
}
func (b *semanticBackend) WritePaste(_ context.Context, _ Attach, input PasteInput) error {
	b.pastes = append(b.pastes, input)
	return nil
}
func (*semanticBackend) Resize(_ context.Context, _ Attach, resize Resize) (EffectiveGeometry, error) {
	return EffectiveGeometry{Generation: 2, PresentationSequence: 2, Cols: resize.Cols, Rows: resize.Rows}, nil
}
func (b *semanticBackend) Activate(_ context.Context, _ Attach, activate Activate) (Activated, error) {
	b.activations = append(b.activations, activate)
	if b.rejectFirstActivation && len(b.activations) == 1 {
		return Activated{}, &ControllerEpochMismatchError{
			Controller: EffectiveController{Epoch: activate.ControllerEpoch + 1, IsController: false},
		}
	}
	return Activated{
		Sequence: activate.Sequence, ControllerEpoch: activate.ControllerEpoch + 1,
		GeometryGeneration: 2, PresentationSequence: 2, Cols: activate.Cols, Rows: activate.Rows,
	}, nil
}

func TestServiceKeepsConnectionLiveAfterStaleActivationEpoch(t *testing.T) {
	backend := &semanticBackend{rejectFirstActivation: true}
	server, client := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- NewService(backend).Serve(context.Background(), server) }()
	attach, _ := EncodeAttach(Attach{AttachGeneration: 7, Cols: 46, Rows: 16, SessionID: "session", ConnectionID: "workbench"})
	_, _ = client.Write(attach)
	if _, err := ReadFrame(client); err != nil {
		t.Fatal(err)
	}
	first, _ := EncodeActivate(Activate{Sequence: 1, ControllerEpoch: 3, Cols: 120, Rows: 40})
	_, _ = client.Write(first)
	rejectedFrame, err := ReadFrame(client)
	if err != nil || rejectedFrame.Type != FrameActivationRejected {
		t.Fatalf("activation rejection=%+v err=%v", rejectedFrame, err)
	}
	rejected, err := DecodeActivationRejected(rejectedFrame)
	if err != nil || rejected.Sequence != 1 || rejected.Controller.Epoch != 4 || rejected.Controller.IsController {
		t.Fatalf("activation rejection=%+v err=%v", rejected, err)
	}
	second, _ := EncodeActivate(Activate{Sequence: 2, ControllerEpoch: 4, Cols: 120, Rows: 40})
	_, _ = client.Write(second)
	appliedFrame, err := ReadFrame(client)
	if err != nil || appliedFrame.Type != FrameActivated {
		t.Fatalf("activation retry=%+v err=%v", appliedFrame, err)
	}
	applied, err := DecodeActivated(appliedFrame)
	if err != nil || applied.Sequence != 2 || applied.ControllerEpoch != 5 {
		t.Fatalf("activation retry=%+v err=%v", applied, err)
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

func TestServiceReassemblesPasteBeforeOneBackendAdmission(t *testing.T) {
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
	payload := bytes.Repeat([]byte("p"), MaxInputBytes+17)
	first, _ := EncodePasteChunk(PasteChunk{Sequence: 1, Start: true, Data: payload[:MaxInputBytes]})
	last, _ := EncodePasteChunk(PasteChunk{Sequence: 2, End: true, Data: payload[MaxInputBytes:]})
	_, _ = client.Write(first)
	_, _ = client.Write(last)
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
	if len(backend.pastes) != 1 || backend.pastes[0].Sequence != 2 || !bytes.Equal(backend.pastes[0].Data, payload) {
		t.Fatalf("pastes=%+v", backend.pastes)
	}
}

func TestServiceRejectsIncompletePasteWithoutBackendAdmission(t *testing.T) {
	tests := []struct {
		name   string
		frames func() [][]byte
	}{
		{
			name: "missing start",
			frames: func() [][]byte {
				frame, _ := EncodePasteChunk(PasteChunk{Sequence: 1, End: true, Data: []byte("tail")})
				return [][]byte{frame}
			},
		},
		{
			name: "duplicate start",
			frames: func() [][]byte {
				first, _ := EncodePasteChunk(PasteChunk{Sequence: 1, Start: true, Data: []byte("first")})
				second, _ := EncodePasteChunk(PasteChunk{Sequence: 2, Start: true, End: true, Data: []byte("second")})
				return [][]byte{first, second}
			},
		},
		{
			name: "sequence gap",
			frames: func() [][]byte {
				first, _ := EncodePasteChunk(PasteChunk{Sequence: 1, Start: true, Data: []byte("first")})
				second, _ := EncodePasteChunk(PasteChunk{Sequence: 3, End: true, Data: []byte("second")})
				return [][]byte{first, second}
			},
		},
		{
			name: "interrupted by input",
			frames: func() [][]byte {
				first, _ := EncodePasteChunk(PasteChunk{Sequence: 1, Start: true, Data: []byte("first")})
				input, _ := EncodeInput(Input{Sequence: 2, Data: []byte("x")})
				return [][]byte{first, input}
			},
		},
		{
			name: "over size limit",
			frames: func() [][]byte {
				frames := make([][]byte, 0, MaxPasteBytes/MaxInputBytes+1)
				chunk := bytes.Repeat([]byte("p"), MaxInputBytes)
				for sequence := uint64(1); sequence <= MaxPasteBytes/MaxInputBytes; sequence++ {
					frame, _ := EncodePasteChunk(PasteChunk{Sequence: sequence, Start: sequence == 1, Data: chunk})
					frames = append(frames, frame)
				}
				last, _ := EncodePasteChunk(PasteChunk{Sequence: uint64(MaxPasteBytes/MaxInputBytes + 1), End: true, Data: []byte("x")})
				return append(frames, last)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
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
			for _, frame := range test.frames() {
				_, _ = client.Write(frame)
			}
			if frame, err := ReadFrame(client); err != nil || frame.Type != FrameError {
				t.Fatalf("protocol error frame=%+v err=%v", frame, err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, ErrProtocolViolation) {
					t.Fatalf("service error=%v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("service did not stop")
			}
			if len(backend.pastes) != 0 || len(backend.inputs) != 0 || len(backend.intents) != 0 {
				t.Fatalf("partial input reached backend: pastes=%d inputs=%d intents=%d", len(backend.pastes), len(backend.inputs), len(backend.intents))
			}
		})
	}
}

func TestServiceAppliesActivationBeforeFollowingInput(t *testing.T) {
	backend := &semanticBackend{}
	server, client := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- NewService(backend).Serve(context.Background(), server) }()
	attach, _ := EncodeAttach(Attach{AttachGeneration: 7, Cols: 46, Rows: 16, SessionID: "session", ConnectionID: "workbench"})
	_, _ = client.Write(attach)
	if _, err := ReadFrame(client); err != nil {
		t.Fatal(err)
	}
	activate, _ := EncodeActivate(Activate{Sequence: 1, ControllerEpoch: 3, Cols: 120, Rows: 40})
	input, _ := EncodeInput(Input{Sequence: 1, Data: []byte("x")})
	writeDone := make(chan error, 1)
	go func() { _, writeErr := client.Write(append(activate, input...)); writeDone <- writeErr }()
	frame, err := ReadFrame(client)
	if err != nil || frame.Type != FrameActivated {
		t.Fatalf("activation ack=%+v err=%v", frame, err)
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
	applied, err := DecodeActivated(frame)
	if err != nil || applied.Cols != 120 || applied.Rows != 40 || applied.ControllerEpoch != 4 {
		t.Fatalf("activation=%+v err=%v", applied, err)
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
	if len(backend.activations) != 1 || len(backend.inputs) != 1 || string(backend.inputs[0].Data) != "x" {
		t.Fatalf("activations=%+v inputs=%+v", backend.activations, backend.inputs)
	}
}
