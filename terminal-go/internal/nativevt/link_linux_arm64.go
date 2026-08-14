//go:build floeterm_native && linux && arm64

package nativevt

/*
#cgo LDFLAGS: ${SRCDIR}/generated/lib/libghostty-vt-linux-arm64.a -lstdc++ -lm
*/
import "C"
