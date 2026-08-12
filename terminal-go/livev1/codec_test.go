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

func TestDecoderHandlesEveryFragmentBoundary(t *testing.T) {
	output, err := EncodeOutputBatch(OutputBatch{
		GeometryGeneration: 5,
		Cols:               120,
		Rows:               40,
		Records: []OutputRecord{
			{Sequence: 9, TimestampMs: 10, GeometryGeneration: 5, Cols: 120, Rows: 40, Data: []byte("\x1b[2J\x1b[Htop")},
			{Sequence: 10, TimestampMs: 11, GeometryGeneration: 5, Cols: 120, Rows: 40, Data: []byte("中e\xcc\x81🙂")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for split := 1; split < len(output); split++ {
		decoder := NewDecoder()
		frames, pushErr := decoder.Push(output[:split])
		if pushErr != nil || len(frames) != 0 {
			t.Fatalf("split %d first push frames=%d err=%v", split, len(frames), pushErr)
		}
		frames, pushErr = decoder.Push(output[split:])
		if pushErr != nil || len(frames) != 1 || frames[0].Type != FrameOutputBatch {
			t.Fatalf("split %d second push frames=%#v err=%v", split, frames, pushErr)
		}
		decoded, decodeErr := DecodeOutputBatch(frames[0])
		if decodeErr != nil || len(decoded.Records) != 2 || !bytes.Equal(decoded.Records[0].Data, []byte("\x1b[2J\x1b[Htop")) || !bytes.Equal(decoded.Records[1].Data, []byte("中e\xcc\x81🙂")) {
			t.Fatalf("split %d decoded=%+v err=%v", split, decoded, decodeErr)
		}
	}
}

func TestDecoderPreservesResizeBoundaryStreamAcrossEveryByte(t *testing.T) {
	frames := make([][]byte, 0, 5)
	appendFrame := func(encoded []byte, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, encoded)
	}
	appendFrame(EncodeAttached(Attached{HistoryBoundarySequence: 8, HistoryGeneration: 1, HistoryStartSequence: 1, GeometryGeneration: 4, Cols: 80, Rows: 24}))
	appendFrame(EncodeOutputBatch(OutputBatch{GeometryGeneration: 4, Cols: 80, Rows: 24, Records: []OutputRecord{{Sequence: 9, TimestampMs: 10, GeometryGeneration: 4, Cols: 80, Rows: 24, Data: []byte("\x1b[?1049h\x1b[HOLD")}}}))
	appendFrame(EncodeResizeApplied(ResizeApplied{Sequence: 3, GeometryGeneration: 5, OutputSequenceBoundary: 9, Cols: 120, Rows: 40}))
	appendFrame(EncodeGeometryChanged(EffectiveGeometry{Generation: 5, OutputSequenceBoundary: 9, Cols: 120, Rows: 40}))
	appendFrame(EncodeOutputBatch(OutputBatch{GeometryGeneration: 5, Cols: 120, Rows: 40, Records: []OutputRecord{{Sequence: 10, TimestampMs: 11, GeometryGeneration: 5, Cols: 120, Rows: 40, Data: []byte("\x1b[2J\x1b[HNEW中e\xcc\x81🙂")}}}))
	stream := bytes.Join(frames, nil)
	decoder := NewDecoder()
	var decoded []Frame
	for index := range stream {
		pushed, err := decoder.Push(stream[index : index+1])
		if err != nil {
			t.Fatalf("byte %d: %v", index, err)
		}
		decoded = append(decoded, pushed...)
	}
	if len(decoded) != 5 {
		t.Fatalf("decoded %d frames, want 5", len(decoded))
	}
	resize, err := DecodeResizeApplied(decoded[2])
	if err != nil || resize.OutputSequenceBoundary != 9 || resize.GeometryGeneration != 5 {
		t.Fatalf("resize boundary=%+v error=%v", resize, err)
	}
	geometry, err := DecodeGeometryChanged(decoded[3])
	if err != nil || geometry.OutputSequenceBoundary != 9 || geometry.Generation != 5 {
		t.Fatalf("geometry boundary=%+v error=%v", geometry, err)
	}
	oldOutput, oldErr := DecodeOutputBatch(decoded[1])
	newOutput, newErr := DecodeOutputBatch(decoded[4])
	if oldErr != nil || newErr != nil || oldOutput.Records[0].Sequence != 9 || newOutput.Records[0].Sequence != 10 || oldOutput.GeometryGeneration != 4 || newOutput.GeometryGeneration != 5 {
		t.Fatalf("old=%+v/%v new=%+v/%v", oldOutput, oldErr, newOutput, newErr)
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
