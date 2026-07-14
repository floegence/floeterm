package terminal

import (
	"bytes"
	"testing"
)

func TestRingBufferWriteRead(t *testing.T) {
	buffer := NewTerminalRingBuffer(4)

	if err := buffer.Write([]byte("one")); err != nil {
		t.Fatalf("write failed: %v", err)
	}
	if err := buffer.Write([]byte("two")); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(chunks))
	}

	if !bytes.Equal(chunks[0].Data, []byte("one")) {
		t.Fatalf("first chunk mismatch: %s", string(chunks[0].Data))
	}
	if !bytes.Equal(chunks[1].Data, []byte("two")) {
		t.Fatalf("second chunk mismatch: %s", string(chunks[1].Data))
	}

	if chunks[0].Sequence != 1 || chunks[1].Sequence != 2 {
		t.Fatalf("sequence numbers not incrementing as expected: %d %d", chunks[0].Sequence, chunks[1].Sequence)
	}
}

func TestRingBufferOverflow(t *testing.T) {
	buffer := NewTerminalRingBuffer(3)

	for i := 0; i < 5; i++ {
		if err := buffer.Write([]byte{byte('a' + i)}); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(chunks))
	}

	if chunks[0].Data[0] != 'c' || chunks[1].Data[0] != 'd' || chunks[2].Data[0] != 'e' {
		t.Fatalf("unexpected overflow order: %q %q %q", chunks[0].Data, chunks[1].Data, chunks[2].Data)
	}
}

func TestRingBufferClear(t *testing.T) {
	buffer := NewTerminalRingBuffer(2)
	_ = buffer.Write([]byte("one"))

	buffer.Clear()
	if got := buffer.ReadAllChunks(); len(got) != 0 {
		t.Fatalf("expected empty buffer after clear, got %d chunks", len(got))
	}
}

func TestRingBufferReadChunksFrom(t *testing.T) {
	buffer := NewTerminalRingBuffer(5)
	_ = buffer.Write([]byte("alpha"))
	_ = buffer.Write([]byte("beta"))
	_ = buffer.Write([]byte("gamma"))

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(chunks))
	}

	cutoff := chunks[1].Timestamp
	filtered := buffer.ReadChunksFrom(cutoff)
	if len(filtered) < 2 {
		t.Fatalf("expected at least 2 chunks from cutoff, got %d", len(filtered))
	}
}

func TestRingBufferStatsTotalBytesWithOverflow(t *testing.T) {
	buffer := NewTerminalRingBuffer(3)
	_ = buffer.Write([]byte("a"))   // 1
	_ = buffer.Write([]byte("bb"))  // 2
	_ = buffer.Write([]byte("ccc")) // 3
	if got := buffer.GetStats().TotalBytes; got != 6 {
		t.Fatalf("expected total bytes 6 before overflow, got %d", got)
	}

	_ = buffer.Write([]byte("dddd")) // overwrite "a" (1), new total should be 2+3+4=9
	if got := buffer.GetStats().TotalBytes; got != 9 {
		t.Fatalf("expected total bytes 9 after overflow, got %d", got)
	}
}

func TestRingBufferEvictsWholeChunksAtByteLimit(t *testing.T) {
	buffer := NewTerminalRingBufferWithByteLimit(8, 6)
	for _, value := range []string{"aa", "bbb", "cccc"} {
		if err := buffer.Write([]byte(value)); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 1 || string(chunks[0].Data) != "cccc" {
		t.Fatalf("unexpected retained chunks: %+v", chunks)
	}
	if got := buffer.GetStats().TotalBytes; got != 4 {
		t.Fatalf("TotalBytes=%d, want 4", got)
	}
}

func TestRingBufferByteAndChunkLimitsCompose(t *testing.T) {
	buffer := NewTerminalRingBufferWithByteLimit(2, 8)
	for _, value := range []string{"aa", "bb", "cc"} {
		_ = buffer.Write([]byte(value))
	}
	chunks := buffer.ReadAllChunks()
	if len(chunks) != 2 || string(chunks[0].Data) != "bb" || string(chunks[1].Data) != "cc" {
		t.Fatalf("unexpected retained chunks: %+v", chunks)
	}
}

func TestRingBufferGrowsChunkSlotsWithinByteLimit(t *testing.T) {
	buffer := NewTerminalRingBufferWithLimits(2, 8, 8)
	for _, value := range []string{"a", "b", "c", "d", "e", "f"} {
		if err := buffer.Write([]byte(value)); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 6 {
		t.Fatalf("len(chunks)=%d, want 6", len(chunks))
	}
	for index, chunk := range chunks {
		if got, want := chunk.Sequence, int64(index+1); got != want {
			t.Fatalf("chunk[%d].Sequence=%d, want %d", index, got, want)
		}
	}
	stats := buffer.GetStats()
	if stats.TotalChunks != 8 || stats.TotalBytes != 6 {
		t.Fatalf("stats=%+v, want 8 slots and 6 bytes", stats)
	}
}

func TestRingBufferGrowthStillEnforcesByteAndMaxChunkLimits(t *testing.T) {
	buffer := NewTerminalRingBufferWithLimits(2, 4, 3)
	for _, value := range []string{"a", "b", "c", "d", "e"} {
		_ = buffer.Write([]byte(value))
	}

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 3 || string(chunks[0].Data) != "c" || string(chunks[2].Data) != "e" {
		t.Fatalf("unexpected retained chunks: %+v", chunks)
	}
	stats := buffer.GetStats()
	if stats.TotalChunks != 4 || stats.TotalBytes != 3 {
		t.Fatalf("stats=%+v, want 4 slots and 3 bytes", stats)
	}
}

func TestRingBufferClearShrinksDynamicSlotsToInitialCapacity(t *testing.T) {
	buffer := NewTerminalRingBufferWithLimits(2, 8, 8)
	for _, value := range []string{"a", "b", "c", "d", "e"} {
		_ = buffer.Write([]byte(value))
	}
	if got := buffer.GetStats().TotalChunks; got != 8 {
		t.Fatalf("TotalChunks=%d before clear, want 8", got)
	}

	buffer.Clear()
	stats := buffer.GetStats()
	if stats.TotalChunks != 2 || stats.UsedChunks != 0 || stats.TotalBytes != 0 {
		t.Fatalf("stats after clear=%+v, want initial empty capacity", stats)
	}
}

func TestRingBufferLegacyByteLimitConstructorKeepsFixedCapacity(t *testing.T) {
	buffer := NewTerminalRingBufferWithByteLimit(2, 8)
	for _, value := range []string{"a", "b", "c"} {
		_ = buffer.Write([]byte(value))
	}
	chunks := buffer.ReadAllChunks()
	if len(chunks) != 2 || string(chunks[0].Data) != "b" || string(chunks[1].Data) != "c" {
		t.Fatalf("unexpected fixed-capacity chunks: %+v", chunks)
	}
	if got := buffer.GetStats().TotalChunks; got != 2 {
		t.Fatalf("TotalChunks=%d, want fixed capacity 2", got)
	}
}

func TestRingBufferRetainsSingleOversizedChunkWithoutSlicing(t *testing.T) {
	buffer := NewTerminalRingBufferWithByteLimit(4, 3)
	_ = buffer.Write([]byte("one"))
	_ = buffer.Write([]byte("oversized"))

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 1 || string(chunks[0].Data) != "oversized" {
		t.Fatalf("unexpected retained chunks: %+v", chunks)
	}
}

func TestRingBufferClearResetsByteLimitedBuffer(t *testing.T) {
	buffer := NewTerminalRingBufferWithByteLimit(4, 8)
	_ = buffer.Write([]byte("one"))
	buffer.Clear()
	_ = buffer.Write([]byte("two"))

	chunks := buffer.ReadAllChunks()
	if len(chunks) != 1 || chunks[0].Sequence != 1 || string(chunks[0].Data) != "two" {
		t.Fatalf("unexpected chunks after clear: %+v", chunks)
	}
	if got := buffer.GetStats().TotalBytes; got != 3 {
		t.Fatalf("TotalBytes=%d, want 3", got)
	}
}

func TestRingBufferReadChunkPageRespectsChunkLimit(t *testing.T) {
	buffer := NewTerminalRingBuffer(8)
	for _, value := range []string{"one", "two", "three", "four"} {
		if err := buffer.Write([]byte(value)); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{
		StartSeq:    2,
		LimitChunks: 2,
	})

	if len(page.Chunks) != 2 {
		t.Fatalf("len(page.Chunks)=%d, want 2", len(page.Chunks))
	}
	if page.Chunks[0].Sequence != 2 || page.Chunks[1].Sequence != 3 {
		t.Fatalf("unexpected page sequences: %+v", page.Chunks)
	}
	if !page.HasMore || page.NextStartSeq != 4 {
		t.Fatalf("unexpected paging metadata: %+v", page)
	}
	if page.FirstSequence != 2 || page.LastSequence != 3 {
		t.Fatalf("unexpected page coverage: first=%d last=%d", page.FirstSequence, page.LastSequence)
	}
}

func TestRingBufferReadChunkPageRespectsByteLimit(t *testing.T) {
	buffer := NewTerminalRingBuffer(8)
	for _, value := range []string{"aa", "bbb", "cccc"} {
		if err := buffer.Write([]byte(value)); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{MaxBytes: 5})

	if len(page.Chunks) != 2 {
		t.Fatalf("len(page.Chunks)=%d, want 2", len(page.Chunks))
	}
	if got := page.CoveredBytes; got != 5 {
		t.Fatalf("CoveredBytes=%d, want 5", got)
	}
	if !page.HasMore || page.NextStartSeq != 3 {
		t.Fatalf("unexpected paging metadata: %+v", page)
	}
}

func TestRingBufferReadChunkPageReturnsSingleOversizedChunk(t *testing.T) {
	buffer := NewTerminalRingBuffer(8)
	if err := buffer.Write([]byte("oversized")); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{MaxBytes: 2})

	if len(page.Chunks) != 1 {
		t.Fatalf("len(page.Chunks)=%d, want 1", len(page.Chunks))
	}
	if page.HasMore {
		t.Fatalf("HasMore=true, want false for the only retained chunk")
	}
	if got := string(page.Chunks[0].Data); got != "oversized" {
		t.Fatalf("chunk data=%q, want oversized", got)
	}
}

func TestRingBufferReadChunkPageRespectsEndSeq(t *testing.T) {
	buffer := NewTerminalRingBuffer(8)
	for _, value := range []string{"one", "two", "three", "four"} {
		if err := buffer.Write([]byte(value)); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{StartSeq: 2, EndSeq: 3})

	if len(page.Chunks) != 2 {
		t.Fatalf("len(page.Chunks)=%d, want 2", len(page.Chunks))
	}
	if page.Chunks[0].Sequence != 2 || page.Chunks[1].Sequence != 3 {
		t.Fatalf("unexpected page sequences: %+v", page.Chunks)
	}
	if page.HasMore {
		t.Fatalf("HasMore=true, want false when end sequence cuts the read")
	}
}

func TestRingBufferReadChunkPageAfterOverflow(t *testing.T) {
	buffer := NewTerminalRingBuffer(3)
	for _, value := range []string{"one", "two", "three", "four", "five"} {
		if err := buffer.Write([]byte(value)); err != nil {
			t.Fatalf("write failed: %v", err)
		}
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{StartSeq: 1, LimitChunks: 2})

	if len(page.Chunks) != 2 {
		t.Fatalf("len(page.Chunks)=%d, want 2", len(page.Chunks))
	}
	if page.Chunks[0].Sequence != 3 || page.Chunks[1].Sequence != 4 {
		t.Fatalf("unexpected retained page sequences: %+v", page.Chunks)
	}
	if !page.HasMore || page.NextStartSeq != 5 {
		t.Fatalf("unexpected paging metadata after overflow: %+v", page)
	}
}

func TestRingBufferReadChunkPageEmptyBuffer(t *testing.T) {
	buffer := NewTerminalRingBuffer(3)

	page := buffer.ReadChunkPage(HistoryPageOptions{LimitChunks: 1})

	if len(page.Chunks) != 0 {
		t.Fatalf("len(page.Chunks)=%d, want 0", len(page.Chunks))
	}
	if page.HasMore || page.NextStartSeq != 0 {
		t.Fatalf("unexpected empty page metadata: %+v", page)
	}
	if page.UsedChunks != 0 || page.TotalBytes != 0 {
		t.Fatalf("unexpected empty stats: %+v", page)
	}
}

func TestRingBufferHistoryCoverageTracksSparseSequences(t *testing.T) {
	buffer := NewTerminalRingBuffer(8)
	if err := buffer.writeOwnedWithSequence([]byte("one"), 1, 1000, false); err != nil {
		t.Fatal(err)
	}
	if err := buffer.writeOwnedWithSequence([]byte("three"), 3, 3000, false); err != nil {
		t.Fatal(err)
	}

	first := buffer.ReadChunkPage(HistoryPageOptions{LimitChunks: 1})
	if first.NextStartSeq != 3 || first.CoveredThroughSequence != 2 || first.SnapshotEndSequence != 3 {
		t.Fatalf("unexpected sparse first page: %+v", first)
	}
	second := buffer.ReadChunkPage(HistoryPageOptions{StartSeq: first.NextStartSeq, EndSeq: first.SnapshotEndSequence})
	if second.HasMore || second.CoveredThroughSequence != 3 {
		t.Fatalf("unexpected sparse final page: %+v", second)
	}
}

func TestRingBufferHistoryPageReportsRetentionFloorOnEmptyRange(t *testing.T) {
	buffer := NewTerminalRingBuffer(2)
	for sequence, value := range []string{"one", "two", "three"} {
		if err := buffer.writeOwnedWithSequence([]byte(value), int64(sequence+1), int64(sequence+1), false); err != nil {
			t.Fatal(err)
		}
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{StartSeq: 1, EndSeq: 2})
	if page.FirstRetainedSequence != 2 || !page.HistoryTruncated {
		t.Fatalf("expected retained floor truncation metadata, got %+v", page)
	}
}

func TestRingBufferHistoryPageReportsFullyEvictedBoundedRange(t *testing.T) {
	buffer := NewTerminalRingBuffer(2)
	for sequence, value := range []string{"one", "two", "three", "four"} {
		if err := buffer.writeOwnedWithSequence([]byte(value), int64(sequence+1), int64(sequence+1), false); err != nil {
			t.Fatal(err)
		}
	}

	page := buffer.ReadChunkPage(HistoryPageOptions{StartSeq: 1, EndSeq: 2})
	if len(page.Chunks) != 0 || page.FirstRetainedSequence != 3 || !page.HistoryTruncated {
		t.Fatalf("expected fully evicted bounded range, got %+v", page)
	}
}

func TestRingBufferInitialHistoryDetectsOnlyARealRetentionGap(t *testing.T) {
	complete := NewTerminalRingBuffer(2)
	if err := complete.writeOwnedWithSequence([]byte("one"), 1, 1, false); err != nil {
		t.Fatal(err)
	}
	if page := complete.ReadChunkPage(HistoryPageOptions{}); page.HistoryTruncated {
		t.Fatalf("sequence one should not report truncation: %+v", page)
	}

	truncated := NewTerminalRingBuffer(2)
	for sequence := int64(1); sequence <= 3; sequence++ {
		if err := truncated.writeOwnedWithSequence([]byte("data"), sequence, sequence, false); err != nil {
			t.Fatal(err)
		}
	}
	if page := truncated.ReadChunkPage(HistoryPageOptions{}); !page.HistoryTruncated || page.FirstRetainedSequence != 2 {
		t.Fatalf("initial replay should report the missing sequence one: %+v", page)
	}
}
