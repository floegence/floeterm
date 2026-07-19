//go:build !darwin && !linux

package terminal

import (
	"fmt"
	"os"
	"runtime"
)

func newPTYOutputMonitor(*os.File) (ptyOutputMonitor, error) {
	return nil, fmt.Errorf("PTY output monitoring is unsupported on %s", runtime.GOOS)
}
