//go:build darwin || linux

package terminal

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func requestPTYForegroundRedraw(master *os.File) error {
	if master == nil {
		return os.ErrInvalid
	}
	var processGroup int32
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		master.Fd(),
		syscall.TIOCGPGRP,
		uintptr(unsafe.Pointer(&processGroup)),
	)
	if errno != 0 {
		return errno
	}
	if processGroup <= 0 {
		return fmt.Errorf("PTY foreground process group is unavailable")
	}
	return syscall.Kill(-int(processGroup), syscall.SIGWINCH)
}
