//go:build checkpoint_contract

package terminal

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// This tagged contract preserves the original raw-only eviction RED as a
// checkpoint+contiguous-delta recovery proof without burdening default tests.
func TestHistoryEvictionRequiresAuthoritativeCheckpointContract(t *testing.T) {
	manager := NewManager(ManagerConfig{
		Logger:                      NopLogger{},
		HistoryBufferSize:           3,
		HistoryBufferMaxChunks:      3,
		HistorySpoolRoot:            t.TempDir(),
		HistorySpoolSegmentMaxBytes: 128,
		HistorySpoolMaxBytes:        1 << 20,
	})
	t.Cleanup(manager.Cleanup)
	session, err := manager.CreateSession("history-checkpoint-contract", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	outputs := [][]byte{
		[]byte("\x1b[?1049h\x1b[2J\x1b[Htop initial full frame"),
		[]byte("\x1b[2J\x1b[H\x1b[31mPID 1 long process row\x1b[0m"),
		[]byte("\x1b[2;1H\x1b[2KPID 2 short"),
		[]byte("\x1b[3;1H\x1b[2KPID 3 short"),
		[]byte("\x1b[4;1H\x1b[2KPID 4 short"),
	}
	for _, output := range outputs {
		session.processRawPTYData(output)
	}

	ringPage := session.ringBuffer.ReadChunkPage(HistoryPageOptions{StartSeq: 1, EndSeq: session.committedSequence})
	if !ringPage.HistoryTruncated || ringPage.FirstRetainedSequence <= 1 {
		t.Fatalf("fixture did not evict the alternate-screen bootstrap from the hot ring: %+v", ringPage)
	}
	checkpointBytes := []byte("opaque-self-restored-ghostty-checkpoint-through-sequence-4")
	checkpointChecksum := sha256.Sum256(checkpointBytes)
	stateDigest := sha256.Sum256([]byte("canonical-ghostty-state-through-sequence-4"))
	if err := session.CommitHistoryCheckpoint(TerminalHistoryCheckpoint{
		FormatVersion:          1,
		EngineID:               "floegence-ghostty-web",
		CoveredThroughSequence: 4,
		GeometryGeneration:     1,
		ParserEpoch:            1,
		Cols:                   80,
		Rows:                   24,
		ChecksumSHA256:         hex.EncodeToString(checkpointChecksum[:]),
		StateDigestSHA256:      hex.EncodeToString(stateDigest[:]),
		Bytes:                  checkpointBytes,
	}); err != nil {
		t.Fatal(err)
	}

	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: session.committedSequence})
	if err != nil {
		t.Fatal(err)
	}
	if !page.HistoryTruncated || page.Checkpoint == nil || page.Checkpoint.CoveredThroughSequence != 4 {
		t.Fatalf("history page did not return an authoritative checkpoint: %+v", page)
	}
	if page.DeltaStartSequence != 5 || page.FirstRetainedSequence != 5 || len(page.Chunks) != 1 || page.Chunks[0].Sequence != 5 {
		t.Fatalf("checkpoint delta is not contiguous: %+v", page)
	}
}
