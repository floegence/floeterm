//go:build checkpoint_contract

package terminal

import (
	"reflect"
	"testing"
)

// This is intentionally RED until the published Ghostty checkpoint API and
// the terminal history checkpoint+delta contract exist. It prevents a raw
// truncated page from being mistaken for an authoritative terminal baseline.
func TestHistoryEvictionRequiresAuthoritativeCheckpointContract(t *testing.T) {
	session := &Session{
		ID:                   "history-checkpoint-contract",
		connections:          make(map[string]*ConnectionInfo),
		liveAttachments:      make(map[string]liveAttachment),
		ringBuffer:           NewTerminalRingBuffer(3),
		historyGeneration:    1,
		historyStartSequence: 1,
		config:               newSessionConfig(ManagerConfig{Logger: NopLogger{}}),
	}

	for _, output := range [][]byte{
		[]byte("\x1b[?1049h\x1b[2J\x1b[Htop initial full frame"),
		[]byte("\x1b[2J\x1b[H\x1b[31mPID 1 long process row\x1b[0m"),
		[]byte("\x1b[2;1H\x1b[2KPID 2 short"),
		[]byte("\x1b[3;1H\x1b[2KPID 3 short"),
		[]byte("\x1b[4;1H\x1b[2KPID 4 short"),
	} {
		session.processRawPTYData(output)
	}

	page, err := session.GetHistoryPage(HistoryPageOptions{StartSeq: 1, EndSeq: session.committedSequence})
	if err != nil {
		t.Fatal(err)
	}
	if !page.HistoryTruncated || page.FirstRetainedSequence <= 1 {
		t.Fatalf("fixture did not evict the alternate-screen bootstrap: %+v", page)
	}

	pageType := reflect.TypeOf(page)
	if _, ok := pageType.FieldByName("Checkpoint"); !ok {
		t.Fatalf(
			"raw-only HistoryPage cannot authoritatively restore an evicted terminal state: first_retained=%d covered_through=%d chunks=%d history_truncated=%t; add a validated checkpoint plus contiguous delta contract",
			page.FirstRetainedSequence,
			page.CoveredThroughSequence,
			len(page.Chunks),
			page.HistoryTruncated,
		)
	}
}
