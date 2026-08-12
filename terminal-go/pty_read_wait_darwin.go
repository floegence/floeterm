//go:build darwin

package terminal

import "syscall"

func waitPTYReadable(fd, cancelFD int) (bool, error) {
	if fd < 0 || cancelFD < 0 || fd >= len(syscall.FdSet{}.Bits)*32 || cancelFD >= len(syscall.FdSet{}.Bits)*32 {
		return false, syscall.EINVAL
	}
	var readable syscall.FdSet
	readable.Bits[fd/32] |= int32(1 << uint(fd%32))
	readable.Bits[cancelFD/32] |= int32(1 << uint(cancelFD%32))
	err := syscall.Select(max(fd, cancelFD)+1, &readable, nil, nil, nil)
	if err != nil {
		return false, err
	}
	return readable.Bits[fd/32]&(int32(1)<<uint(fd%32)) != 0, nil
}
