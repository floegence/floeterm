//go:build !darwin && !linux

package terminal

import "syscall"

func waitPTYReadable(int, int) (bool, error) {
	return false, syscall.ENOTSUP
}
