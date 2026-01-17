package terminal

import "fmt"

const (
	minTerminalCols = 20
	minTerminalRows = 5
	maxTerminalCols = 500
	maxTerminalRows = 200
)

func validateTerminalSize(cols, rows int) error {
	if cols < minTerminalCols || cols > maxTerminalCols {
		return fmt.Errorf("invalid cols: %d", cols)
	}
	if rows < minTerminalRows || rows > maxTerminalRows {
		return fmt.Errorf("invalid rows: %d", rows)
	}
	return nil
}

func clampTerminalSize(cols, rows int) (int, int) {
	if cols < minTerminalCols {
		cols = minTerminalCols
	}
	if rows < minTerminalRows {
		rows = minTerminalRows
	}
	if cols > maxTerminalCols {
		cols = maxTerminalCols
	}
	if rows > maxTerminalRows {
		rows = maxTerminalRows
	}
	return cols, rows
}

