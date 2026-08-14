package livev1

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestSemanticCodecRoundTrip(t *testing.T) {
	attachBytes, err := EncodeAttach(Attach{AttachGeneration: 2, Cols: 80, Rows: 24, SessionID: "session", ConnectionID: "view"})
	if err != nil {
		t.Fatal(err)
	}
	frame, err := ReadFrame(bytes.NewReader(attachBytes))
	if err != nil {
		t.Fatal(err)
	}
	attach, err := DecodeAttach(frame)
	if err != nil || attach.AttachGeneration != 2 || attach.Cols != 80 || attach.Rows != 24 {
		t.Fatalf("attach = %+v, err = %v", attach, err)
	}

	intentBytes, err := EncodeInputIntent(InputIntent{
		Sequence:  2,
		Code:      "ArrowUp",
		Action:    KeyActionRepeat,
		Modifiers: KeyModifierShift | KeyModifierControl,
	})
	if err != nil {
		t.Fatal(err)
	}
	intentFrame, err := ReadFrame(bytes.NewReader(intentBytes))
	if err != nil {
		t.Fatal(err)
	}
	intent, err := DecodeInputIntent(intentFrame)
	if err != nil || intent.Sequence != 2 || intent.Code != "ArrowUp" || intent.Action != KeyActionRepeat || intent.Modifiers != 3 {
		t.Fatalf("input intent = %+v, err = %v", intent, err)
	}

	attachedBytes, err := EncodeAttached(Attached{PresentationSequence: 9, GeometryGeneration: 3, ControllerEpoch: 4, Cols: 100, Rows: 30, IsController: true})
	if err != nil {
		t.Fatal(err)
	}
	attachedFrame, err := ReadFrame(bytes.NewReader(attachedBytes))
	if err != nil {
		t.Fatal(err)
	}
	attached, err := DecodeAttached(attachedFrame)
	if err != nil || attached.PresentationSequence != 9 || attached.GeometryGeneration != 3 {
		t.Fatalf("attached = %+v, err = %v", attached, err)
	}

	resizeBytes, err := EncodeResizeApplied(ResizeApplied{Sequence: 4, GeometryGeneration: 5, PresentationSequence: 11, Cols: 120, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}
	resizeFrame, err := ReadFrame(bytes.NewReader(resizeBytes))
	if err != nil {
		t.Fatal(err)
	}
	resize, err := DecodeResizeApplied(resizeFrame)
	if err != nil || resize.PresentationSequence != 11 || resize.Sequence != 4 {
		t.Fatalf("resize = %+v, err = %v", resize, err)
	}

	presentationBytes, err := EncodePresentation(map[string]any{"v": 1, "sequence": 4})
	if err != nil {
		t.Fatal(err)
	}
	presentationFrame, err := ReadFrame(bytes.NewReader(presentationBytes))
	if err != nil || presentationFrame.Type != FramePresentation {
		t.Fatalf("presentation frame = %+v, err = %v", presentationFrame, err)
	}
}

func TestInputIntentRejectsUnknownActionAndModifierBits(t *testing.T) {
	for _, value := range []InputIntent{
		{Sequence: 1, Code: "Enter", Action: KeyAction(99)},
		{Sequence: 1, Code: "Enter", Action: KeyActionPress, Modifiers: 1 << 15},
		{Sequence: 1, Code: "", Action: KeyActionPress},
	} {
		if _, err := EncodeInputIntent(value); err == nil {
			t.Fatalf("invalid intent was accepted: %+v", value)
		}
	}
}

func TestTerminalLiveV1VectorsMatchCodec(t *testing.T) {
	data, err := os.ReadFile("../../protocol/terminal_live_v1_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Kind    string `json:"kind"`
		Vectors []struct {
			Name string `json:"name"`
			Hex  string `json:"hex"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Kind != StreamKind {
		t.Fatalf("vector kind = %q", contract.Kind)
	}
	encoded := map[string][]byte{}
	encoded["attach"], _ = EncodeAttach(Attach{AttachGeneration: 1, Cols: 80, Rows: 24, SessionID: "s1", ConnectionID: "c1"})
	encoded["input"], _ = EncodeInput(Input{Sequence: 1, Data: []byte("abc")})
	encoded["input_intent"], _ = EncodeInputIntent(InputIntent{Sequence: 2, Code: "ArrowUp", Action: KeyActionRepeat, Modifiers: KeyModifierShift | KeyModifierControl})
	encoded["resize"], _ = EncodeResize(Resize{Sequence: 7, Cols: 80, Rows: 24})
	encoded["activate"], _ = EncodeActivate(Activate{Sequence: 1, ControllerEpoch: 1, Cols: 80, Rows: 24})
	encoded["attached"], _ = EncodeAttached(Attached{PresentationSequence: 42, GeometryGeneration: 3, ControllerEpoch: 1, Cols: 80, Rows: 24, IsController: true})
	encoded["resize_applied"], _ = EncodeResizeApplied(ResizeApplied{Sequence: 7, GeometryGeneration: 5, PresentationSequence: 42, Cols: 80, Rows: 24})
	encoded["geometry_changed"], _ = EncodeGeometryChanged(EffectiveGeometry{Generation: 5, PresentationSequence: 42, Cols: 80, Rows: 24})
	encoded["activated"], _ = EncodeActivated(Activated{Sequence: 1, ControllerEpoch: 2, GeometryGeneration: 5, PresentationSequence: 42, Cols: 80, Rows: 24})
	encoded["controller_changed"], _ = EncodeControllerChanged(EffectiveController{Epoch: 2, IsController: true})
	encoded["activation_rejected"], _ = EncodeActivationRejected(ActivationRejected{
		Sequence: 1, Controller: EffectiveController{Epoch: 2, IsController: true},
	})
	if len(contract.Vectors) != len(encoded) {
		t.Fatalf("vector count = %d, want %d", len(contract.Vectors), len(encoded))
	}
	for _, vector := range contract.Vectors {
		want, err := hex.DecodeString(vector.Hex)
		if err != nil {
			t.Fatalf("%s hex: %v", vector.Name, err)
		}
		got, ok := encoded[vector.Name]
		if !ok || !bytes.Equal(got, want) {
			t.Fatalf("%s vector = %x, want %x", vector.Name, got, want)
		}
	}
}

func TestRemovedRawOutputFrameIsRejected(t *testing.T) {
	frame := make([]byte, HeaderSize)
	frame[0] = 0x82
	if _, err := ReadFrame(bytes.NewReader(frame)); err == nil {
		t.Fatal("removed raw output frame was accepted")
	}
}
