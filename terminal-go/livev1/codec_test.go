package livev1

import (
	"bytes"
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

	attachedBytes, err := EncodeAttached(Attached{PresentationSequence: 9, GeometryGeneration: 3, Cols: 100, Rows: 30})
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

func TestRemovedRawOutputFrameIsRejected(t *testing.T) {
	frame := make([]byte, HeaderSize)
	frame[0] = 0x82
	if _, err := ReadFrame(bytes.NewReader(frame)); err == nil {
		t.Fatal("removed raw output frame was accepted")
	}
}
