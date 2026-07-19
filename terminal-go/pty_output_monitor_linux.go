//go:build linux

package terminal

import (
	"os"
	"sync"
	"syscall"
	"unsafe"
)

type linuxPTYOutputMonitor struct {
	mu     sync.Mutex
	fd     int
	closed bool
	err    error
}

func newPTYOutputMonitor(master *os.File) (ptyOutputMonitor, error) {
	if master == nil {
		return nil, os.ErrInvalid
	}
	fd, err := syscall.Dup(int(master.Fd()))
	if err != nil {
		return nil, err
	}
	return &linuxPTYOutputMonitor{fd: fd}, nil
}

func (m *linuxPTYOutputMonitor) PendingBytes() (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return 0, os.ErrClosed
	}
	var value int32
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		uintptr(m.fd),
		syscall.TIOCINQ,
		uintptr(unsafe.Pointer(&value)),
	)
	if errno != 0 {
		return 0, errno
	}
	return int(value), nil
}

func (m *linuxPTYOutputMonitor) Close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return m.err
	}
	m.closed = true
	m.err = syscall.Close(m.fd)
	return m.err
}
