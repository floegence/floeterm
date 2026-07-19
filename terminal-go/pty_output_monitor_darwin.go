//go:build darwin

package terminal

import (
	"errors"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

type darwinPTYOutputMonitor struct {
	mu     sync.Mutex
	slave  *os.File
	closed bool
	err    error
}

func newPTYOutputMonitor(master *os.File) (ptyOutputMonitor, error) {
	name, err := darwinPTYSlaveName(master)
	if err != nil {
		return nil, err
	}
	slave, err := os.OpenFile(name, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, err
	}
	return &darwinPTYOutputMonitor{slave: slave}, nil
}

func (m *darwinPTYOutputMonitor) PendingBytes() (int, error) {
	if m == nil {
		return 0, os.ErrClosed
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.slave == nil {
		return 0, os.ErrClosed
	}
	return darwinIoctlInt(m.slave.Fd(), syscall.TIOCOUTQ)
}

func (m *darwinPTYOutputMonitor) Close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return m.err
	}
	m.closed = true
	if m.slave != nil {
		m.err = m.slave.Close()
	}
	return m.err
}

func darwinPTYSlaveName(master *os.File) (string, error) {
	if master == nil {
		return "", os.ErrInvalid
	}
	name := make([]byte, 128)
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		master.Fd(),
		syscall.TIOCPTYGNAME,
		uintptr(unsafe.Pointer(&name[0])),
	)
	if errno != 0 {
		return "", errno
	}
	for index, value := range name {
		if value == 0 {
			return string(name[:index]), nil
		}
	}
	return "", errors.New("PTY slave name is not NUL-terminated")
}

func darwinIoctlInt(fd uintptr, request uintptr) (int, error) {
	var value int32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, request, uintptr(unsafe.Pointer(&value)))
	if errno != 0 {
		return 0, errno
	}
	return int(value), nil
}
