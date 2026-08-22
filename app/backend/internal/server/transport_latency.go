package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	terminal "github.com/floegence/floeterm/terminal-go"
)

// transportLatencyInjector is example-only. It sits at the HTTP/WebSocket
// boundary so every data direction can be exercised without changing the
// terminal or protocol packages used by production consumers.
type transportLatencyInjector struct {
	min    time.Duration
	max    time.Duration
	rng    *randSource
	mu     sync.Mutex
	nextID uint64
	logger terminal.Logger
}

// randSource keeps the injector's deterministic random sequence behind the
// same lock as its request identity. This avoids data races when websocket
// reads and writes are active concurrently.
type randSource struct {
	value uint64
}

func (r *randSource) next(max uint64) uint64 {
	if max == 0 {
		return 0
	}
	// xorshift64* is sufficient for a local deterministic latency sequence and
	// avoids exposing the math/rand generator to concurrent callers.
	r.value ^= r.value >> 12
	r.value ^= r.value << 25
	r.value ^= r.value >> 27
	return (r.value * 2685821657736338717) % max
}

func newTransportLatencyInjector(min, max time.Duration, seed int64, logger terminal.Logger) *transportLatencyInjector {
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
	return &transportLatencyInjector{
		min: min, max: max, rng: &randSource{value: uint64(seed)}, logger: logger,
	}
}

func (i *transportLatencyInjector) begin(direction string) (string, time.Duration) {
	if i == nil {
		return "", 0
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.nextID++
	delay := i.min
	if i.max > i.min {
		delay += time.Duration(i.rng.next(uint64(i.max-i.min) + 1))
	}
	return fmt.Sprintf("transport-%d-%s", i.nextID, direction), delay
}

func (i *transportLatencyInjector) wait(ctx context.Context, requestID, direction string, delay time.Duration) error {
	if i == nil || delay <= 0 {
		return nil
	}
	i.logger.Debug("delaying example transport", "requestID", requestID, "direction", direction, "delay", delay)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (i *transportLatencyInjector) complete(requestID, direction string, bytes int, delay time.Duration, started time.Time, err error) {
	if i == nil {
		return
	}
	i.logger.Info("example transport completed",
		"requestID", requestID, "direction", direction, "delay", delay,
		"bytes", bytes, "duration", time.Since(started), "error", err,
	)
}

type delayedTransportConn struct {
	net.Conn
	ctx      context.Context
	injector *transportLatencyInjector
}

func (c *delayedTransportConn) Read(payload []byte) (int, error) {
	requestID, delay := c.injector.begin("read")
	started := time.Now()
	if err := c.injector.wait(c.ctx, requestID, "read", delay); err != nil {
		c.injector.complete(requestID, "read", 0, delay, started, err)
		return 0, err
	}
	count, err := c.Conn.Read(payload)
	c.injector.complete(requestID, "read", count, delay, started, err)
	return count, err
}

func (c *delayedTransportConn) Write(payload []byte) (int, error) {
	requestID, delay := c.injector.begin("write")
	started := time.Now()
	if err := c.injector.wait(c.ctx, requestID, "write", delay); err != nil {
		c.injector.complete(requestID, "write", 0, delay, started, err)
		return 0, err
	}
	count, err := c.Conn.Write(payload)
	c.injector.complete(requestID, "write", count, delay, started, err)
	return count, err
}

type delayedTransportHandler struct {
	next     http.Handler
	injector *transportLatencyInjector
}

func (h delayedTransportHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestID, delay := h.injector.begin("http")
	started := time.Now()
	if err := h.injector.wait(r.Context(), requestID, "http", delay); err != nil {
		h.injector.complete(requestID, "http", 0, delay, started, err)
		http.Error(w, "transport simulation canceled", 408)
		return
	}
	h.next.ServeHTTP(w, r)
	h.injector.complete(requestID, "http", 0, delay, started, nil)
}
