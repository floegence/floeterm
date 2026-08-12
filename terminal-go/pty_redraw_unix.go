//go:build darwin || linux

package terminal

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func requestPTYForegroundRedraw(master *os.File) error {
	processGroup, err := ptyForegroundProcessGroup(master)
	if err != nil {
		return err
	}
	return syscall.Kill(-processGroup, syscall.SIGWINCH)
}

func ptyForegroundProcessGroup(master *os.File) (int, error) {
	if master == nil {
		return 0, os.ErrInvalid
	}
	var processGroup int32
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		master.Fd(),
		syscall.TIOCGPGRP,
		uintptr(unsafe.Pointer(&processGroup)),
	)
	if errno != 0 {
		return 0, errno
	}
	if processGroup <= 0 {
		return 0, fmt.Errorf("PTY foreground process group is unavailable")
	}
	return int(processGroup), nil
}
