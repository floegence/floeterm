//go:build floeterm_native && floeterm_test_fault

package nativevt

/*
#include "generated/adapter.h"
*/
import "C"

func triggerNativeFatalForTest() {
	C.native_test_fatal()
}
