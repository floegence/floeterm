package server

import (
	"context"
	"fmt"
	"testing"
	"time"

	terminal "github.com/floegence/floeterm/terminal-go"
)

type historyLatencyTestLogger struct {
	info []any
}

func (*historyLatencyTestLogger) Debug(string, ...any) {}
func (l *historyLatencyTestLogger) Info(_ string, kv ...any) { l.info = append([]any(nil), kv...) }
func (*historyLatencyTestLogger) Warn(string, ...any)  {}
func (*historyLatencyTestLogger) Error(string, ...any) {}

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

func TestHistoryLatencyInjectorLogsTargetOffsetValue(t *testing.T) {
	logger := &historyLatencyTestLogger{}
	injector := newHistoryLatencyInjector(time.Millisecond, time.Millisecond, 1, logger)
	target := 42
	injector.complete("request-1", "demand", "viewport", 7, &target, 128, time.Millisecond, time.Now(), nil)

	for index := 0; index+1 < len(logger.info); index += 2 {
		if logger.info[index] == "targetOffset" {
			if got, ok := logger.info[index+1].(int); !ok || got != target {
				t.Fatalf("targetOffset log value = %#v, want %d", logger.info[index+1], target)
			}
			return
		}
	}
	t.Fatal("targetOffset log field was not recorded")
}
