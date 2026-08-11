package terminal

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testHistorySpoolChunk(sequence int64, data string) TerminalDataChunk {
	return TerminalDataChunk{
		Sequence:           sequence,
		Data:               []byte(data),
		Timestamp:          sequence * 10,
		Size:               len(data),
		GeometryGeneration: 1,
		Cols:               80,
		Rows:               24,
	}
}

func openTestHistorySpool(t *testing.T, directory string) *TerminalHistorySpool {
	t.Helper()
	spool, err := OpenTerminalHistorySpool(TerminalHistorySpoolOptions{
		Directory:       directory,
		SegmentMaxBytes: 96,
		MaxBytes:        1 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	return spool
}

func TestTerminalHistorySpoolRecoversContiguousOutputAcrossReopen(t *testing.T) {
	directory := t.TempDir()
	spool := openTestHistorySpool(t, directory)
	for sequence := int64(1); sequence <= 5; sequence++ {
		if err := spool.Append(testHistorySpoolChunk(sequence, "output")); err != nil {
			t.Fatal(err)
		}
	}
	if err := spool.Close(); err != nil {
		t.Fatal(err)
	}

	reopened := openTestHistorySpool(t, directory)
	t.Cleanup(func() { _ = reopened.Close() })
	chunks, err := reopened.ReadChunks(1, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 5 {
		t.Fatalf("recovered %d chunks, want 5", len(chunks))
	}
	for index, chunk := range chunks {
		wantSequence := int64(index + 1)
		if chunk.Sequence != wantSequence || string(chunk.Data) != "output" {
			t.Fatalf("chunk %d = %+v", index, chunk)
		}
	}
	if snapshot := reopened.Snapshot(); snapshot.FirstSequence != 1 || snapshot.LastSequence != 5 || snapshot.RetentionFloor != 0 {
		t.Fatalf("unexpected recovered snapshot: %+v", snapshot)
	}
}

func TestTerminalHistorySpoolRejectsCorruptSegment(t *testing.T) {
	directory := t.TempDir()
	spool := openTestHistorySpool(t, directory)
	if err := spool.Append(testHistorySpoolChunk(1, "authoritative")); err != nil {
		t.Fatal(err)
	}
	if err := spool.Close(); err != nil {
		t.Fatal(err)
	}

	segments, err := filepath.Glob(filepath.Join(directory, "segment-*.ftraw"))
	if err != nil || len(segments) == 0 {
		t.Fatalf("segment discovery failed: files=%v err=%v", segments, err)
	}
	bytes, err := os.ReadFile(segments[0])
	if err != nil {
		t.Fatal(err)
	}
	bytes[len(bytes)-1] ^= 0xff
	if err := os.WriteFile(segments[0], bytes, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err = OpenTerminalHistorySpool(TerminalHistorySpoolOptions{
		Directory:       directory,
		SegmentMaxBytes: 96,
		MaxBytes:        1 << 20,
	})
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("corrupt segment error = %v", err)
	}
}

func TestTerminalHistorySpoolCommitsCheckpointBeforeAdvancingRetentionFloor(t *testing.T) {
	directory := t.TempDir()
	spool := openTestHistorySpool(t, directory)
	t.Cleanup(func() { _ = spool.Close() })
	for sequence := int64(1); sequence <= 5; sequence++ {
		if err := spool.Append(testHistorySpoolChunk(sequence, "delta")); err != nil {
			t.Fatal(err)
		}
	}

	checkpointBytes := []byte("opaque-validated-ghostty-checkpoint")
	checkpointHash := sha256.Sum256(checkpointBytes)
	stateDigest := sha256.Sum256([]byte("canonical-state"))
	checkpoint := TerminalHistoryCheckpoint{
		FormatVersion:          1,
		EngineID:               "floegence-ghostty-web",
		CoveredThroughSequence: 4,
		GeometryGeneration:     1,
		Cols:                   80,
		Rows:                   24,
		ChecksumSHA256:         hex.EncodeToString(checkpointHash[:]),
		StateDigestSHA256:      hex.EncodeToString(stateDigest[:]),
		Bytes:                  checkpointBytes,
	}

	invalid := checkpoint
	invalid.ChecksumSHA256 = strings.Repeat("0", 64)
	if err := spool.CommitCheckpoint(invalid); err == nil {
		t.Fatal("checkpoint with the wrong checksum was accepted")
	}
	if snapshot := spool.Snapshot(); snapshot.RetentionFloor != 0 || snapshot.FirstSequence != 1 {
		t.Fatalf("failed checkpoint advanced retention: %+v", snapshot)
	}
	if chunks, err := spool.ReadChunks(1, 5); err != nil || len(chunks) != 5 {
		t.Fatalf("failed checkpoint lost raw chunks: chunks=%d err=%v", len(chunks), err)
	}

	if err := spool.CommitCheckpoint(checkpoint); err != nil {
		t.Fatal(err)
	}
	snapshot := spool.Snapshot()
	if snapshot.RetentionFloor != 4 || snapshot.FirstSequence != 5 || snapshot.LastSequence != 5 {
		t.Fatalf("checkpoint did not atomically advance retention: %+v", snapshot)
	}
	recovered, err := spool.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	if recovered == nil || recovered.CoveredThroughSequence != 4 || string(recovered.Bytes) != string(checkpointBytes) {
		t.Fatalf("unexpected recovered checkpoint: %+v", recovered)
	}
	chunks, err := spool.ReadChunks(5, 5)
	if err != nil || len(chunks) != 1 || chunks[0].Sequence != 5 {
		t.Fatalf("checkpoint delta = %+v, err=%v", chunks, err)
	}
	if err := spool.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openTestHistorySpool(t, directory)
	t.Cleanup(func() { _ = reopened.Close() })
	reopenedCheckpoint, err := reopened.Checkpoint()
	if err != nil || reopenedCheckpoint == nil || reopenedCheckpoint.CoveredThroughSequence != 4 {
		t.Fatalf("reopened checkpoint = %+v, err=%v", reopenedCheckpoint, err)
	}
	reopenedDelta, err := reopened.ReadChunks(5, 5)
	if err != nil || len(reopenedDelta) != 1 || reopenedDelta[0].Sequence != 5 {
		t.Fatalf("reopened checkpoint delta = %+v, err=%v", reopenedDelta, err)
	}
}
