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
