package server

import (
	"context"
	"testing"
	"time"

	terminal "github.com/floegence/floeterm/terminal-go"
)

func TestTransportLatencyInjectorUsesDeterministicBoundedDelays(t *testing.T) {
	left := newTransportLatencyInjector(100*time.Millisecond, 2*time.Second, 17, terminal.NopLogger{})
	right := newTransportLatencyInjector(100*time.Millisecond, 2*time.Second, 17, terminal.NopLogger{})
	for index := 0; index < 8; index++ {
		leftID, leftDelay := left.begin("read")
		rightID, rightDelay := right.begin("read")
		if leftID != rightID || leftDelay != rightDelay {
			t.Fatalf("sequence %d differs: left=(%s,%s) right=(%s,%s)", index, leftID, leftDelay, rightID, rightDelay)
		}
		if leftDelay < 100*time.Millisecond || leftDelay > 2*time.Second {
			t.Fatalf("sequence %d delay out of bounds: %s", index, leftDelay)
		}
	}
}

func TestTransportLatencyInjectorCanBeCanceled(t *testing.T) {
	injector := newTransportLatencyInjector(5*time.Second, 5*time.Second, 1, terminal.NopLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	requestID, delay := injector.begin("write")
	if err := injector.wait(ctx, requestID, "write", delay); err == nil {
		t.Fatal("expected canceled transport delay")
	}
}

func TestTransportLatencyInjectorDisabledByDefault(t *testing.T) {
	if injector := newTransportLatencyInjector(0, 0, 1, terminal.NopLogger{}); injector != nil {
		t.Fatal("expected zero max latency to disable transport injection")
	}
}
