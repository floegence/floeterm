//go:build floeterm_native && linux && amd64

package nativevt

/*
#cgo LDFLAGS: ${SRCDIR}/generated/lib/libghostty-vt-linux-amd64.a -lstdc++ -lm
*/
import "C"
