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

func TestDefaultHistoryFilter_RemovesTerminalQueries(t *testing.T) {
	filter := DefaultHistoryFilter{}

	input := []TerminalDataChunk{{
		Sequence:  1,
		Timestamp: 1,
		Data: []byte(
			"hello" +
				"\x1b[c" + // DA query
				"\x1b[>0c" + // secondary DA query
				"\x1b[6n" + // DSR-6 query
				"\x1b[?1u" + // kitty keyboard query
				"\x1b[?2004$p" + // DECRQM query
				"\x1b[>0q" + // XTVERSION query
				"\x1b[?1004h" + // focus reporting toggle
				"\x1b]10;?\x07" + // OSC 10 colour query
				"world",
		),
		Size: 0,
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
