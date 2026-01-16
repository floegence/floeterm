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
