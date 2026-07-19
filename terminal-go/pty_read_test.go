package terminal

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

type cappedReader struct {
	reader *bytes.Reader
	limit  int
}

func (r *cappedReader) Read(target []byte) (int, error) {
	if len(target) > r.limit {
		target = target[:r.limit]
	}
	return r.reader.Read(target)
}

func TestReadPTYPacketsSendsBurstHeadThenCoalescesPendingOutput(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 33*1024)
	reader := &cappedReader{reader: bytes.NewReader(payload), limit: 1024}
	reads := make(chan ptyReadResult, 4)

	readPTYPacketsWithPending(reader, reads, func() (int, error) {
		return reader.reader.Len(), nil
	}, nil)

	first := <-reads
	second := <-reads
	terminal := <-reads
	if len(first.data) != 1024 || first.err != nil {
		t.Fatalf("first result=%d/%v, want 1024/nil", len(first.data), first.err)
	}
	if len(second.data) != 32*1024 || second.err != nil {
		t.Fatalf("second result=%d/%v, want 32768/nil", len(second.data), second.err)
	}
	if len(terminal.data) != 0 || !errors.Is(terminal.err, io.EOF) {
		t.Fatalf("terminal result=%d/%v, want 0/EOF", len(terminal.data), terminal.err)
	}
	if _, ok := <-reads; ok {
		t.Fatal("PTY result channel remained open after EOF")
	}
}

func TestCollectAvailablePTYBurstDrainsOnlyBufferedReads(t *testing.T) {
	reads := make(chan ptyReadResult, 3)
	reads <- ptyReadResult{data: bytes.Repeat([]byte("a"), 1024)}
	reads <- ptyReadResult{data: bytes.Repeat([]byte("b"), 1024)}
	reads <- ptyReadResult{data: bytes.Repeat([]byte("c"), 1024)}
	first := <-reads
	buffer := make([]byte, 32*1024)

	n, pending, err := collectAvailablePTYBurst(first, reads, buffer)
	if err != nil {
		t.Fatal(err)
	}
	if pending != nil {
		t.Fatalf("unexpected pending read: %+v", pending)
	}
	if n != 3*1024 {
		t.Fatalf("read bytes=%d, want %d", n, 3*1024)
	}
	if !bytes.Equal(buffer[:1024], bytes.Repeat([]byte("a"), 1024)) ||
		!bytes.Equal(buffer[1024:2048], bytes.Repeat([]byte("b"), 1024)) ||
		!bytes.Equal(buffer[2048:3072], bytes.Repeat([]byte("c"), 1024)) {
		t.Fatal("buffered PTY reads were not preserved in order")
	}

	empty := make(chan ptyReadResult, 1)
	n, pending, err = collectAvailablePTYBurst(
		ptyReadResult{data: bytes.Repeat([]byte("x"), 1024)},
		empty,
		buffer,
	)
	if err != nil || pending != nil || n != 1024 {
		t.Fatalf("empty drain bytes=%d pending=%v error=%v, want 1024/nil/nil", n, pending, err)
	}
}

func TestCollectAvailablePTYBurstCarriesOverflowAndTerminalError(t *testing.T) {
	wantErr := io.EOF
	reads := make(chan ptyReadResult, 1)
	reads <- ptyReadResult{data: bytes.Repeat([]byte("b"), 20*1024), err: wantErr}
	buffer := make([]byte, 32*1024)

	n, pending, err := collectAvailablePTYBurst(
		ptyReadResult{data: bytes.Repeat([]byte("a"), 20*1024)},
		reads,
		buffer,
	)
	if err != nil {
		t.Fatalf("first burst error=%v, want nil while data remains", err)
	}
	if n != len(buffer) {
		t.Fatalf("first burst bytes=%d, want %d", n, len(buffer))
	}
	if pending == nil || len(pending.data) != 8*1024 || !errors.Is(pending.err, wantErr) {
		t.Fatalf("pending=%+v, want 8 KiB with EOF", pending)
	}

	n, pending, err = collectAvailablePTYBurst(*pending, reads, buffer)
	if n != 8*1024 || pending != nil || !errors.Is(err, wantErr) {
		t.Fatalf("second burst bytes=%d pending=%v error=%v, want 8192/nil/EOF", n, pending, err)
	}
}

type dataAndErrorReader struct {
	data []byte
	err  error
}

func (r *dataAndErrorReader) Read(target []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, r.err
	}
	n := copy(target, r.data)
	r.data = r.data[n:]
	return n, r.err
}

func TestReadPTYPacketsPreservesDataReturnedWithEOF(t *testing.T) {
	reads := make(chan ptyReadResult, 1)
	readPTYPackets(&dataAndErrorReader{data: []byte("last"), err: io.EOF}, reads)

	result, ok := <-reads
	if !ok {
		t.Fatal("PTY result channel closed before the final read")
	}
	if string(result.data) != "last" || !errors.Is(result.err, io.EOF) {
		t.Fatalf("result=%+v, want last/EOF", result)
	}
	if _, ok := <-reads; ok {
		t.Fatal("PTY result channel remained open after EOF")
	}
}
