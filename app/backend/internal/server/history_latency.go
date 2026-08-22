package server

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	terminal "github.com/floegence/floeterm/terminal-go"
)

// historyLatencyInjector is deliberately owned by the example HTTP server.
// It never sits in terminal-go, so normal consumers cannot accidentally add
// artificial latency to input, live presentation, or resize traffic.
type historyLatencyInjector struct {
	min    time.Duration
	max    time.Duration
	rng    *rand.Rand
	mu     sync.Mutex
	nextID uint64
	logger terminal.Logger
}

func newHistoryLatencyInjector(min, max time.Duration, seed int64, logger terminal.Logger) *historyLatencyInjector {
	if min < 0 {
		min = 0
	}
	if max < min {
		max = min
	}
	if max <= 0 {
		return nil
	}
	if seed == 0 {
		seed = 1
	}
	return &historyLatencyInjector{
		min: min, max: max, rng: rand.New(rand.NewSource(seed)), logger: logger,
	}
}

func (i *historyLatencyInjector) begin(clientRequestID string) (string, time.Duration) {
	if i == nil {
		return clientRequestID, 0
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.nextID++
	delay := i.min
	if i.max > i.min {
		delay += time.Duration(i.rng.Int63n(int64(i.max-i.min) + 1))
	}
	if clientRequestID == "" {
		clientRequestID = fmt.Sprintf("history-%d", i.nextID)
	}
	return clientRequestID, delay
}

func (i *historyLatencyInjector) wait(ctx context.Context, requestID string, delay time.Duration) error {
	if i == nil || delay <= 0 {
		return nil
	}
	i.logger.Debug("delaying semantic history request", "requestID", requestID, "delay", delay)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (i *historyLatencyInjector) complete(requestID, priority, lane string, offset int, target *int, bytes int, delay time.Duration, started time.Time, err error) {
	if i == nil {
		return
	}
	i.logger.Info("semantic history request completed",
		"requestID", requestID, "priority", priority, "lane", lane, "offset", offset,
		"targetOffset", target, "delay", delay, "bytes", bytes,
		"duration", time.Since(started), "error", err,
	)
}
