package livev1

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

type vectorFile struct {
	Kind    string `json:"kind"`
	Vectors []struct {
		Name string `json:"name"`
		Hex  string `json:"hex"`
	} `json:"vectors"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "protocol", "terminal_live_v1_vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vectors vectorFile
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	return vectors
}

func TestProtocolVectors(t *testing.T) {
	vectors := loadVectors(t)
	if vectors.Kind != StreamKind {
		t.Fatalf("kind = %q, want %q", vectors.Kind, StreamKind)
	}

	encoded := map[string][]byte{}
	attach, err := EncodeAttach(Attach{
		AttachGeneration: 1,
		Cols:             80,
		Rows:             24,
		SessionID:        "s1",
		ConnectionID:     "c1",
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded["attach"] = attach
	encoded["input"], err = EncodeInput(Input{Sequence: 1, Data: []byte("abc")})
	if err != nil {
		t.Fatal(err)
	}
	encoded["resize"], err = EncodeResize(Resize{Sequence: 7, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	encoded["attached"], err = EncodeAttached(Attached{
		HistoryBoundarySequence: 42,
		HistoryGeneration:       3,
		HistoryStartSequence:    40,
		GeometryGeneration:      5,
		Cols:                    80,
		Rows:                    24,
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded["resize_applied"], err = EncodeResizeApplied(ResizeApplied{
		Sequence:               7,
		GeometryGeneration:     5,
		OutputSequenceBoundary: 42,
		Cols:                   80,
		Rows:                   24,
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded["output_batch"], err = EncodeOutputBatch(OutputBatch{
		GeometryGeneration: 5,
		Cols:               80,
		Rows:               24,
		Records: []OutputRecord{{
			Sequence:           9,
			TimestampMs:        10,
			GeometryGeneration: 5,
			Cols:               80,
			Rows:               24,
			Data:               []byte("ab"),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded["geometry_changed"], err = EncodeGeometryChanged(EffectiveGeometry{Generation: 5, OutputSequenceBoundary: 42, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}

	for _, vector := range vectors.Vectors {
		want, err := hex.DecodeString(vector.Hex)
		if err != nil {
			t.Fatalf("decode vector %s: %v", vector.Name, err)
		}
		if !bytes.Equal(encoded[vector.Name], want) {
			t.Fatalf("vector %s = %x, want %x", vector.Name, encoded[vector.Name], want)
		}
	}
}

func TestGeometryPayloadsRejectMissingOrInvalidEffectiveDimensions(t *testing.T) {
	if _, err := EncodeAttached(Attached{
		HistoryGeneration:    1,
		HistoryStartSequence: 1,
	}); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("attached geometry err = %v", err)
	}
	if _, err := EncodeResizeApplied(ResizeApplied{Sequence: 1}); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("resize geometry err = %v", err)
	}
	if _, err := EncodeOutputBatch(OutputBatch{
		Records: []OutputRecord{{Sequence: 1, Data: []byte("x")}},
	}); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("output geometry err = %v", err)
	}
}

func TestDecoderHandlesFragmentedAndCoalescedFrames(t *testing.T) {
	input, err := EncodeInput(Input{Sequence: 1, Data: []byte("a")})
	if err != nil {
		t.Fatal(err)
	}
	resize, err := EncodeResize(Resize{Sequence: 2, Cols: 120, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}

	decoder := NewDecoder()
	frames, err := decoder.Push(input[:5])
	if err != nil || len(frames) != 0 {
		t.Fatalf("first fragment frames=%d err=%v", len(frames), err)
	}
	frames, err = decoder.Push(append(input[5:], resize...))
	if err != nil {
		t.Fatal(err)
	}
	if len(frames) != 2 || frames[0].Type != FrameInput || frames[1].Type != FrameResize {
		t.Fatalf("unexpected frames: %#v", frames)
	}
}

func TestDecoderRejectsReservedBitsAndOversizedPayload(t *testing.T) {
	decoder := NewDecoder()
	_, err := decoder.Push([]byte{byte(FrameInput), 0, 0, 1, 0, 0, 0, 0})
	if !errors.Is(err, ErrReservedBits) {
		t.Fatalf("reserved err = %v", err)
	}

	decoder = NewDecoder()
	size := uint32(MaxFramePayloadBytes + 1)
	_, err = decoder.Push([]byte{byte(FrameInput), 0, 0, 0, byte(size >> 24), byte(size >> 16), byte(size >> 8), byte(size)})
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversize err = %v", err)
	}
}

func TestDecodeInputRejectsUnknownTypeAndInvalidPayload(t *testing.T) {
	if _, err := DecodeInput(Frame{Type: FrameResize}); !errors.Is(err, ErrUnexpectedFrameType) {
		t.Fatalf("type err = %v", err)
	}
	if _, err := DecodeInput(Frame{Type: FrameInput, Payload: make([]byte, 7)}); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("payload err = %v", err)
	}
}
