//go:build floeterm_native && darwin && arm64

package nativevt

/*
#cgo LDFLAGS: ${SRCDIR}/generated/lib/libghostty-vt-darwin-arm64.a -lc++
*/
import "C"
