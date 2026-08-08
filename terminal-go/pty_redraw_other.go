//go:build !darwin && !linux

package terminal

import (
	"errors"
	"os"
)

func requestPTYForegroundRedraw(_ *os.File) error {
	return errors.New("PTY foreground redraw is unsupported on this platform")
}
