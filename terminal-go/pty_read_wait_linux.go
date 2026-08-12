//go:build linux

package terminal

import "syscall"

func waitPTYReadable(fd, cancelFD int) (bool, error) {
	if fd < 0 || cancelFD < 0 || fd >= len(syscall.FdSet{}.Bits)*64 || cancelFD >= len(syscall.FdSet{}.Bits)*64 {
		return false, syscall.EINVAL
	}
	var readable syscall.FdSet
	readable.Bits[fd/64] |= int64(1 << uint(fd%64))
	readable.Bits[cancelFD/64] |= int64(1 << uint(cancelFD%64))
	_, err := syscall.Select(max(fd, cancelFD)+1, &readable, nil, nil, nil)
	if err != nil {
		return false, err
	}
	return readable.Bits[fd/64]&(int64(1)<<uint(fd%64)) != 0, nil
}
