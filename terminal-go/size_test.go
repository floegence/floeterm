package terminal

import "testing"

func TestGetMinimumTerminalSize_ClampsToMax(t *testing.T) {
	s := &Session{
		connections: map[string]*ConnectionInfo{
			"c1": {ConnID: "c1", Cols: 10000, Rows: 10000},
		},
	}

	cols, rows := s.getMinimumTerminalSize()
	if cols != maxTerminalCols || rows != maxTerminalRows {
		t.Fatalf("expected clamped size %dx%d, got %dx%d", maxTerminalCols, maxTerminalRows, cols, rows)
	}
}

func TestValidateTerminalSize_RejectsOutOfRange(t *testing.T) {
	if err := validateTerminalSize(0, 24); err == nil {
		t.Fatalf("expected error for cols=0")
	}
	if err := validateTerminalSize(80, 0); err == nil {
		t.Fatalf("expected error for rows=0")
	}
	if err := validateTerminalSize(maxTerminalCols+1, 24); err == nil {
		t.Fatalf("expected error for oversized cols")
	}
	if err := validateTerminalSize(80, maxTerminalRows+1); err == nil {
		t.Fatalf("expected error for oversized rows")
	}
}

