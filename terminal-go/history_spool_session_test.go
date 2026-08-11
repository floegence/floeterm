package terminal

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
)

func TestSessionHistoryUsesDurableSpoolBeyondHotRingEviction(t *testing.T) {
	root := t.TempDir()
	manager := NewManager(ManagerConfig{
		Logger:                      NopLogger{},
		HistoryBufferSize:           2,
		HistoryBufferMaxChunks:      2,
		HistoryBufferMaxBytes:       128,
		HistorySpoolRoot:            root,
		HistorySpoolSegmentMaxBytes: 128,
		HistorySpoolMaxBytes:        1 << 20,
	})
	t.Cleanup(manager.Cleanup)
	session, err := manager.CreateSession("durable", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for sequence := 1; sequence <= 5; sequence++ {
		session.processRawPTYData([]byte{byte('0' + sequence)})
	}

	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: 5})
	if err != nil {
		t.Fatal(err)
	}
	if page.HistoryTruncated || page.FirstRetainedSequence != 1 || len(page.Chunks) != 5 {
		t.Fatalf("durable history page = %+v", page)
	}
	for index, chunk := range page.Chunks {
		if chunk.Sequence != int64(index+1) || string(chunk.Data) != string([]byte{byte('1' + index)}) {
			t.Fatalf("chunk %d = %+v", index, chunk)
		}
	}
	if _, err := filepath.Glob(filepath.Join(root, session.ID, "segment-*.ftraw")); err != nil {
		t.Fatal(err)
	}
}

func TestSessionHistoryPageUsesValidatedCheckpointAndContiguousDelta(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                      NopLogger{},
		HistoryBufferSize:           2,
		HistoryBufferMaxChunks:      2,
		HistorySpoolRoot:            t.TempDir(),
		HistorySpoolSegmentMaxBytes: 96,
		HistorySpoolMaxBytes:        1 << 20,
	})
	t.Cleanup(manager.Cleanup)
	session, err := manager.CreateSession("checkpoint", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for sequence := 1; sequence <= 5; sequence++ {
		session.processRawPTYData([]byte{byte('0' + sequence)})
	}

	checkpointBytes := []byte("opaque-validated-checkpoint")
	checkpointChecksum := sha256.Sum256(checkpointBytes)
	stateDigest := sha256.Sum256([]byte("state-through-four"))
	checkpoint := TerminalHistoryCheckpoint{
		FormatVersion:          1,
		EngineID:               "floegence-ghostty-web",
		CoveredThroughSequence: 4,
		GeometryGeneration:     1,
		Cols:                   80,
		Rows:                   24,
		ChecksumSHA256:         hex.EncodeToString(checkpointChecksum[:]),
		StateDigestSHA256:      hex.EncodeToString(stateDigest[:]),
		Bytes:                  checkpointBytes,
	}
	if err := manager.CommitSessionHistoryCheckpoint(session.ID, checkpoint); err != nil {
		t.Fatal(err)
	}

	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: 5})
	if err != nil {
		t.Fatal(err)
	}
	if page.Checkpoint == nil || page.Checkpoint.CoveredThroughSequence != 4 {
		t.Fatalf("history page checkpoint = %+v", page.Checkpoint)
	}
	if page.DeltaStartSequence != 5 || page.FirstRetainedSequence != 5 || !page.HistoryTruncated {
		t.Fatalf("history page checkpoint boundary = %+v", page)
	}
	if len(page.Chunks) != 1 || page.Chunks[0].Sequence != 5 || string(page.Chunks[0].Data) != "5" {
		t.Fatalf("history page delta = %+v", page.Chunks)
	}
}

func TestSessionHistoryFailsClosedAfterDurableSpoolQuotaError(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                      NopLogger{},
		HistoryBufferSize:           1,
		HistoryBufferMaxChunks:      1,
		HistoryBufferMaxBytes:       64,
		HistorySpoolRoot:            t.TempDir(),
		HistorySpoolSegmentMaxBytes: 128,
		HistorySpoolMaxBytes:        128,
	})
	t.Cleanup(manager.Cleanup)
	session, err := manager.CreateSession("quota", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session.processRawPTYData([]byte(strings.Repeat("a", 48)))
	session.processRawPTYData([]byte(strings.Repeat("b", 48)))

	_, err = session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: 2})
	if err == nil || !strings.Contains(err.Error(), "quota exceeded") {
		t.Fatalf("history after spool failure error = %v", err)
	}
}

func TestSessionHistorySpoolContinuesFromGlobalSequenceAfterClear(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                      NopLogger{},
		HistoryBufferSize:           1,
		HistoryBufferMaxChunks:      1,
		HistorySpoolRoot:            t.TempDir(),
		HistorySpoolSegmentMaxBytes: 128,
		HistorySpoolMaxBytes:        1 << 20,
	})
	t.Cleanup(manager.Cleanup)
	session, err := manager.CreateSession("clear", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	session.processRawPTYData([]byte("before"))
	if err := session.ClearHistory(); err != nil {
		t.Fatal(err)
	}
	session.processRawPTYData([]byte("after"))

	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 2, EndSeq: 2})
	if err != nil {
		t.Fatal(err)
	}
	if page.FirstRetainedSequence != 2 || len(page.Chunks) != 1 || page.Chunks[0].Sequence != 2 || string(page.Chunks[0].Data) != "after" {
		t.Fatalf("history after clear = %+v", page)
	}
}
