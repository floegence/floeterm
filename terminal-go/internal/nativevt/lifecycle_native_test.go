//go:build floeterm_native

package nativevt

import "testing"

func TestNativeEngineTenThousandHandleLifecycles(t *testing.T) {
	for iteration := 0; iteration < 10_000; iteration++ {
		engine, err := New(2, 1)
		if err != nil {
			t.Fatalf("create native engine at iteration %d: %v", iteration, err)
		}
		engine.Close()
	}
}
