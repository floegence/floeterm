//go:build floeterm_native && darwin && amd64

package nativevt

/*
#cgo LDFLAGS: ${SRCDIR}/generated/lib/libghostty-vt-darwin-amd64.a -lc++
*/
import "C"
