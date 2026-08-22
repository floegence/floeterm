package server

import (
	"context"
	"fmt"
	"testing"
	"time"

	terminal "github.com/floegence/floeterm/terminal-go"
)

func TestHistoryLatencyInjectorUsesDeterministicBoundedDelays(t *testing.T) {
	left := newHistoryLatencyInjector(100*time.Millisecond, 1500*time.Millisecond, 17, terminal.NopLogger{})
	right := newHistoryLatencyInjector(100*time.Millisecond, 1500*time.Millisecond, 17, terminal.NopLogger{})
	for index := 0; index < 8; index++ {
		leftID, leftDelay := left.begin("")
		rightID, rightDelay := right.begin("")
		wantID := fmt.Sprintf("history-%d", index+1)
		if leftID != wantID || rightID != wantID {
			t.Fatalf("request IDs = %q/%q, want %q", leftID, rightID, wantID)
		}
		if leftDelay != rightDelay || leftDelay < 100*time.Millisecond || leftDelay > 1500*time.Millisecond {
			t.Fatalf("delay pair = %s/%s, outside deterministic bounds", leftDelay, rightDelay)
		}
	}
}

func TestHistoryLatencyInjectorCanBeCanceled(t *testing.T) {
	injector := newHistoryLatencyInjector(5*time.Second, 5*time.Second, 1, terminal.NopLogger{})
	requestID, delay := injector.begin("client-request")
	if requestID != "client-request" {
		t.Fatalf("request ID = %q, want client-request", requestID)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := injector.wait(ctx, requestID, delay); err == nil {
		t.Fatal("wait returned nil after context cancellation")
	}
}

func TestHistoryLatencyInjectorDisabledByDefault(t *testing.T) {
	injector := newHistoryLatencyInjector(0, 0, 1, terminal.NopLogger{})
	requestID, delay := injector.begin("disabled-request")
	if requestID != "disabled-request" || delay != 0 || injector.wait(context.Background(), requestID, delay) != nil {
		t.Fatalf("disabled injector = id %q delay %s", requestID, delay)
	}
}
