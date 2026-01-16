package terminal

import "testing"

func TestDefaultHistoryFilter_RemovesOSCAndCSI(t *testing.T) {
	filter := DefaultHistoryFilter{}

	input := []TerminalDataChunk{{
		Sequence:  1,
		Timestamp: 1,
		Data:      []byte("hello\x1b]10;rgb:1/2/3\x07world\x1b[?1;2c"), // OSC 10 + DA response
		Size:      0,
	}}

	output := filter.Filter(input)
	if len(output) != 1 {
		t.Fatalf("expected one chunk after filtering, got %d", len(output))
	}

	got := string(output[0].Data)
	if got != "helloworld" {
		t.Fatalf("unexpected filtered content: %q", got)
	}
}

func TestDefaultHistoryFilter_DropsEmptyChunks(t *testing.T) {
	filter := DefaultHistoryFilter{}

	input := []TerminalDataChunk{{
		Sequence:  1,
		Timestamp: 1,
		Data:      []byte("\x1b[?1;2c"),
		Size:      0,
	}}

	output := filter.Filter(input)
	if len(output) != 0 {
		t.Fatalf("expected filtered output to be empty, got %d", len(output))
	}
}
